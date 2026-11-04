import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  applyNetworkPolicy,
  sandboxName,
} from '../../features/sandbox/openshell';
import {
  defaultPolicy,
  fixedFileRules,
  PolicyStore,
  remoteHost,
  type SecurityPolicy,
  validatePolicy,
} from '../../features/sandbox/policy';
import type {
  SecurityHostMessage,
  SecurityView,
  SecurityWebviewMessage,
} from '../../webview/securityProtocol';
import {
  AGENT_FILES,
  agentDirsNow,
  sandboxKind,
  setSecurityPolicy,
} from '../backlog/agentRunner';
import type { SandboxAudit } from '../backlog/sandboxAudit';
import { SandboxRequests } from '../backlog/sandboxRequests';

/**
 * The Security panel and the policy store behind it, in VS Code's storage: the global one for all repositories, the
 * workspace's for this one. Agents start on the policy in force from now on.
 */
export function createSecurity(
  context: vscode.ExtensionContext,
  mainRoot: string,
  worktrees: () => (string | undefined)[],
  audit: SandboxAudit,
): SecurityPanel {
  let remote: string | undefined;
  try {
    remote = execFileSync('git', ['-C', mainRoot, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // No origin: the default reaches Claude's API only.
  }
  const host = remoteHost(remote);
  const store = new PolicyStore(context.globalStorageUri.fsPath, context.storageUri?.fsPath, () => defaultPolicy(host));
  const policyDir = path.join(context.globalStorageUri.fsPath, 'openshell');
  const sandboxes = () => worktrees().flatMap((p) => (p ? [sandboxName(p)] : []));
  // What a blocked request's Allow once loaded into its sandbox (BL-273) is part of that sandbox's policy.
  const requests = new SandboxRequests(audit, store, sandboxes, policyDir, () => sandboxKind() === 'openshell');
  setSecurityPolicy((sandbox) => (sandbox ? requests.policyOf(sandbox) : store.read()), policyDir);
  return new SecurityPanel(context.extensionUri, store, sandboxes, policyDir, requests);
}

/**
 * The Security panel (BL-271): the policy every sandboxed agent runs under, in an editor tab. Saving checks it, loads its
 * network rules into the running sandboxes (which checks it with OpenShell too), then writes it; its folders apply when
 * each sandbox is next made.
 */
export class SecurityPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: PolicyStore,
    /** The sandboxes of this repository's worktrees, by name: those that are there get the network rules at once. */
    private readonly sandboxes: () => string[],
    /** Where the network rules loaded into running sandboxes are written: outside every mount. */
    private readonly policyDir: string,
    /** The blocked requests that ask the user (BL-273). */
    readonly requests: SandboxRequests,
  ) {
    this.subs.push(requests);
    this.subs.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('flotilla.agents.sandbox')) this.post();
      }),
    );
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel('flotilla.security', 'Security', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [dist],
    });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'flotilla.svg');
    this.panel = panel;
    panel.webview.html = html(panel.webview, dist);
    panel.onDidDispose(() => (this.panel = undefined));
    panel.webview.onDidReceiveMessage((m: SecurityWebviewMessage) => {
      if (m.type === 'securityReady') this.post();
      else if (m.type === 'securitySave') void this.save(m.policy);
      else if (m.type === 'securityScope') this.setScope(m.scope);
      else if (m.type === 'securityEnableSandbox')
        void vscode.workspace.getConfiguration('flotilla').update('agents.sandbox', 'openshell', vscode.ConfigurationTarget.Global);
    });
  }

  view(status?: string): SecurityView {
    return {
      sandbox: sandboxKind(),
      scope: this.store.scope(),
      canScopeRepository: !!this.store.workspaceDir,
      file: this.store.file(),
      saved: this.store.saved(),
      policy: this.store.read(),
      defaults: this.store.defaults(),
      fixed: fixedFileRules({
        agentDirs: agentDirsNow(),
        agentFiles: AGENT_FILES,
        configDir: process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'),
      }),
      ...(status ? { status } : {}),
    };
  }

  private post(status?: string): void {
    this.send({ type: 'securityView', view: this.view(status) });
  }

  private send(m: SecurityHostMessage): void {
    void this.panel?.webview.postMessage(m);
  }

  private setScope(scope: 'all' | 'repository'): void {
    // A repository's own policy starts as the one for all repositories.
    if (scope === 'repository' && !this.store.saved('repository')) this.store.write('repository', this.store.read('all'));
    this.store.setScope(scope);
    this.post(scope === 'repository' ? 'This repository has its own policy now.' : 'This repository uses the policy for all repositories now.');
  }

  private async save(policy: SecurityPolicy): Promise<void> {
    const errors = validatePolicy(policy);
    if (errors.length) {
      this.send({ type: 'securityErrors', errors });
      return;
    }
    let applied: string[] = [];
    if (sandboxKind() === 'openshell') {
      const result = await applyNetworkPolicy(policy, this.sandboxes(), path.join(this.policyDir, 'network-policy.yaml'), undefined, (name) =>
        this.requests.policyOf(name, policy),
      );
      if (result.error) {
        this.send({ type: 'securityErrors', errors: [result.error] });
        return;
      }
      applied = result.applied;
    }
    this.store.write(this.store.scope(), policy);
    const now = applied.length
      ? `Network rules and commands apply now in ${applied.length} running sandbox${applied.length === 1 ? '' : 'es'}`
      : 'No sandbox is running: the rules apply as each agent starts';
    this.post(`Saved. ${now}; folders apply at each agent's next start.`);
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.panel?.dispose();
  }
}

function html(webview: vscode.Webview, dist: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(dist, ...p)).toString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('security.css')}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${uri('security.js')}"></script>
</body>
</html>`;
}
