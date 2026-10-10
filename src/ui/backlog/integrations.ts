import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runGit } from '../../core/git/gitCli';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import { GitHubSource, gitHubRepo } from '../../features/backlog/sources/github';
import { JiraSource } from '../../features/backlog/sources/jira';
import type { Fetch, IntegrationConfig, IssueSource, RemoteIssue } from '../../features/backlog/sources/source';

interface IntegrationsFile {
  version: 1;
  integrations: IntegrationConfig[];
}

const GITHUB_SCOPES = ['repo'];
const jiraSecret = (c: Extract<IntegrationConfig, { kind: 'jira' }>) => `flotilla.jira:${c.site}:${c.email}`;

/** What the backlog shows of one integration: its issues, or why it has none. */
export interface IntegrationState {
  config: IntegrationConfig;
  label: string;
  issues: RemoteIssue[];
  error?: string;
}

/**
 * The backlog's integrations (Jira, GitHub Issues): which are connected (.flotilla/backlog/integrations.json, next to
 * the local backlog; tokens in VS Code's secret storage), and their issues, read when the backlog shows and on
 * Refresh.
 */
export class BacklogIntegrations implements vscode.Disposable {
  private states: IntegrationState[] = [];
  private loading: Promise<void> | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly backlog: LocalBacklog,
    private readonly secrets: vscode.SecretStorage,
    private readonly mainRoot: string,
  ) {}

  dispose(): void {
    this.changed.dispose();
  }

  private get file(): string {
    return path.join(this.backlog.dir, 'integrations.json');
  }

  private async configs(): Promise<IntegrationConfig[]> {
    try {
      const data = JSON.parse(await fs.promises.readFile(this.file, 'utf8')) as IntegrationsFile;
      return Array.isArray(data.integrations) ? data.integrations : [];
    } catch {
      return [];
    }
  }

  private async saveConfigs(integrations: IntegrationConfig[]): Promise<void> {
    await this.backlog.ensureDir();
    await fs.promises.writeFile(this.file, `${JSON.stringify({ version: 1, integrations } satisfies IntegrationsFile, null, 1)}\n`);
  }

  private async source(config: IntegrationConfig): Promise<IssueSource> {
    const fetch = globalThis.fetch as unknown as Fetch;
    if (config.kind === 'jira') {
      const token = await this.secrets.get(jiraSecret(config));
      if (!token) throw new Error('No API token stored on this computer: connect it again.');
      return new JiraSource(config, token, fetch);
    }
    return new GitHubSource(
      config,
      async () => {
        const session = await vscode.authentication.getSession('github', GITHUB_SCOPES, { silent: true });
        if (!session) throw new Error('Sign in to GitHub: connect it again.');
        return session.accessToken;
      },
      fetch,
    );
  }

  /** The integrations and their issues, as last read. */
  get current(): readonly IntegrationState[] {
    return this.states;
  }

  /** All issues of all integrations. */
  issues(): RemoteIssue[] {
    return this.states.flatMap((s) => s.issues);
  }

  /** The integration an issue comes from. */
  async sourceOf(id: string): Promise<IssueSource | undefined> {
    const issue = this.issues().find((i) => i.id === id);
    const state = issue && this.states.find((s) => s.config.id === issue.source);
    return state && this.source(state.config);
  }

  /** Reads every integration's issues (one read at a time; a refresh while reading waits for it). */
  refresh(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const configs = await this.configs();
        this.states = await Promise.all(
          configs.map(async (config): Promise<IntegrationState> => {
            try {
              const source = await this.source(config);
              return { config, label: source.label, issues: await source.list() };
            } catch (error) {
              return { config, label: labelOf(config), issues: [], error: error instanceof Error ? error.message : String(error) };
            }
          }),
        );
        this.changed.fire();
      } finally {
        this.loading = undefined;
      }
    })();
    return this.loading;
  }

  /** The Integrations menu: what's connected (with errors), connect Jira or GitHub Issues, disconnect, refresh. */
  async manage(): Promise<void> {
    type Item = vscode.QuickPickItem & { run?: () => Promise<void> };
    const connected: Item[] = this.states.map((s) => ({
      label: `$(${s.config.kind === 'github' ? 'github' : 'issues'}) ${s.label}`,
      description: s.error ? '$(warning) not loading' : `${s.issues.length} issue${s.issues.length === 1 ? '' : 's'}`,
      detail: s.error ?? (s.config.kind === 'jira' ? s.config.jql : undefined),
      buttons: [{ iconPath: new vscode.ThemeIcon('debug-disconnect'), tooltip: 'Disconnect' }],
      run: async () => void (await vscode.env.openExternal(vscode.Uri.parse(s.config.kind === 'jira' ? s.config.site : `https://github.com/${s.config.owner}/${s.config.repo}/issues`))),
    }));
    const items: Item[] = [
      ...(connected.length ? [{ label: 'Connected', kind: vscode.QuickPickItemKind.Separator }, ...connected] : []),
      { label: 'Add', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(issues) Connect Jira…', detail: 'Issues from a JQL query, with an API token', run: () => this.connectJira() },
      { label: '$(github) Connect GitHub Issues…', detail: "This repository's issues, with your GitHub sign-in", run: () => this.connectGitHub() },
      ...(connected.length ? [{ label: '$(refresh) Refresh Issues', run: () => this.refresh() }] : []),
    ];
    const pick = vscode.window.createQuickPick<Item>();
    pick.title = 'Backlog Integrations';
    pick.placeholder = 'Issues of connected trackers show in the backlog next to its own items';
    pick.items = items;
    const done = new Promise<void>((resolve) => {
      pick.onDidTriggerItemButton(async (e) => {
        const state = this.states[connected.indexOf(e.item)];
        pick.hide();
        if (state) await this.disconnect(state.config);
        resolve();
      });
      pick.onDidAccept(async () => {
        const chosen = pick.selectedItems[0];
        pick.hide();
        await chosen?.run?.();
        resolve();
      });
      pick.onDidHide(() => resolve());
    });
    pick.show();
    await done;
    pick.dispose();
  }

  private async add(config: IntegrationConfig): Promise<void> {
    await this.saveConfigs([...(await this.configs()).filter((c) => c.id !== config.id), config]);
    await this.refresh();
    const state = this.states.find((s) => s.config.id === config.id);
    if (state?.error) void vscode.window.showWarningMessage(`${state.label} is connected, but its issues don't load: ${state.error}`);
    else if (state) void vscode.window.showInformationMessage(`${state.label} is connected: ${state.issues.length} issues in the backlog.`);
  }

  async connectJira(): Promise<void> {
    const site = await vscode.window.showInputBox({
      title: 'Connect Jira (1/4)',
      prompt: 'Your Jira site',
      placeHolder: 'https://your-company.atlassian.net',
      validateInput: (v) => (/^https:\/\/[^/\s]+/.test(v.trim()) ? undefined : 'An https:// address, like https://your-company.atlassian.net'),
    });
    if (!site) return;
    const email = await vscode.window.showInputBox({ title: 'Connect Jira (2/4)', prompt: 'The email address of your Atlassian account', validateInput: (v) => (/.+@.+/.test(v) ? undefined : 'An email address') });
    if (!email) return;
    const token = await vscode.window.showInputBox({
      title: 'Connect Jira (3/4)',
      prompt: 'An API token (create one at id.atlassian.com › Security › API tokens). It stays in VS Code’s secret storage on this computer.',
      password: true,
      ignoreFocusOut: true,
    });
    if (!token) return;
    const jql = await vscode.window.showInputBox({
      title: 'Connect Jira (4/4)',
      prompt: 'Which issues to show (JQL)',
      value: 'assignee = currentUser() AND statusCategory != Done ORDER BY Rank',
      ignoreFocusOut: true,
    });
    if (!jql) return;
    const config: IntegrationConfig = { kind: 'jira', id: `jira:${site.trim().replace(/\/+$/, '')}:${email.trim()}`, site: site.trim().replace(/\/+$/, ''), email: email.trim(), jql };
    await this.secrets.store(jiraSecret(config), token.trim());
    await this.add(config);
  }

  async connectGitHub(): Promise<void> {
    let repo: { owner: string; repo: string } | undefined;
    try {
      repo = gitHubRepo(await runGit(['remote', 'get-url', 'origin'], { cwd: this.mainRoot }));
    } catch {
      // no origin
    }
    const typed = await vscode.window.showInputBox({
      title: 'Connect GitHub Issues',
      prompt: 'The repository whose issues to show (owner/name)',
      value: repo ? `${repo.owner}/${repo.repo}` : '',
      validateInput: (v) => (/^[\w.-]+\/[\w.-]+$/.test(v.trim()) ? undefined : 'owner/name, like octocat/hello-world'),
    });
    if (!typed) return;
    const [owner, name] = typed.trim().split('/');
    // Asks to sign in to GitHub (or to allow Flotilla to use the sign-in) if needed.
    await vscode.authentication.getSession('github', GITHUB_SCOPES, { createIfNone: true });
    await this.add({ kind: 'github', id: `github:${owner}/${name}`, owner, repo: name });
  }

  async disconnect(config: IntegrationConfig): Promise<void> {
    await this.saveConfigs((await this.configs()).filter((c) => c.id !== config.id));
    if (config.kind === 'jira' && !(await this.configs()).some((c) => c.kind === 'jira' && jiraSecret(c) === jiraSecret(config))) {
      await this.secrets.delete(jiraSecret(config));
    }
    await this.refresh();
  }
}

function labelOf(config: IntegrationConfig): string {
  if (config.kind === 'github') return `GitHub ${config.owner}/${config.repo}`;
  try {
    return `Jira ${new URL(config.site).hostname.split('.')[0]}`;
  } catch {
    return 'Jira';
  }
}
