import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runGit } from '../../core/git/gitCli';
import { trackProgress } from '../progress';
import type { IssueLink } from '../../features/backlog/backlog';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import { GitHubSource, gitHubRepo } from '../../features/backlog/sources/github';
import { JiraSource } from '../../features/backlog/sources/jira';
import { markdownToJira } from '../../features/backlog/sources/jiraMarkup';
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

  /** The integration an issue comes from (sourceId for one that isn't among the listed issues, e.g. a linked one). */
  async sourceOf(id: string, sourceId?: string): Promise<IssueSource | undefined> {
    const from = sourceId ?? this.issues().find((i) => i.id === id)?.source;
    const state = from ? this.states.find((s) => s.config.id === from) : undefined;
    return state && this.source(state.config);
  }

  /** Looks an issue up by key in the trackers it could be in: also issues the backlog doesn't list (another JQL). */
  private async lookup(key: string): Promise<RemoteIssue | undefined> {
    const k = key.trim();
    const listed = this.issues().find((i) => i.id.toLowerCase() === k.toLowerCase());
    if (listed) return listed;
    for (const state of this.states) {
      const fits = state.config.kind === 'jira' ? /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(k) : /^(GH-|#)?\d+$/i.test(k);
      if (!fits) continue;
      try {
        return (await (await this.source(state.config)).details(k.toUpperCase().replace(/^#/, ''))).issue;
      } catch {
        // not there; try the next one
      }
    }
    return undefined;
  }

  /**
   * Creates an issue for a local item in a connected tracker, asking where (the integration, and for Jira the project
   * and issue type), then confirming. The description is the ticket's, in the tracker's markup. Undefined if cancelled.
   */
  async createIssue(itemId: string, title: string, markdown: string): Promise<IssueLink | undefined> {
    if (!this.states.length) {
      const choice = await vscode.window.showInformationMessage('Connect Jira or GitHub Issues to create issues there.', 'Connect…');
      if (choice) await this.manage();
      if (!this.states.length) return undefined;
    }
    const state =
      this.states.length === 1
        ? this.states[0]
        : (
            await vscode.window.showQuickPick(
              this.states.map((s) => ({ label: `$(${s.config.kind === 'github' ? 'github' : 'issues'}) ${s.label}`, state: s })),
              { title: `Create an Issue for ${itemId}`, placeHolder: 'In which tracker?' },
            )
          )?.state;
    if (!state) return undefined;
    const source = await this.source(state.config);
    const target: { project?: string; issueType?: string } = {};
    let where = state.label;
    if (source instanceof JiraSource) {
      const projects = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Reading Jira projects…' }, () => source.projects());
      const project = await vscode.window.showQuickPick(
        projects.map((p) => ({ label: p.key, description: p.name })),
        { title: `Create a Jira Issue for ${itemId} (1/2)`, placeHolder: 'Project', matchOnDescription: true },
      );
      if (!project) return undefined;
      const types = await source.issueTypes(project.label);
      const type = await vscode.window.showQuickPick(
        types.map((t) => ({ label: t.name, id: t.id })),
        { title: `Create a Jira Issue for ${itemId} (2/2)`, placeHolder: `Issue type in ${project.label}` },
      );
      if (!type) return undefined;
      // Projects can require fields of their own (a team, a component): those are filled in in Jira.
      const missing = await source.missingOnCreate(project.label, type.id).catch(() => []);
      if (missing.length) {
        const open = await vscode.window.showWarningMessage(
          `${project.label} requires ${missing.join(', ')} on a new ${type.label}, which Flotilla can't fill in. Create it in Jira, then link it.`,
          'Open Jira',
        );
        if (open) await vscode.env.openExternal(vscode.Uri.parse(`${state.config.kind === 'jira' ? state.config.site : ''}/jira/software/projects/${project.label}`));
        return undefined;
      }
      target.project = project.label;
      target.issueType = type.id;
      where = `${project.label} (${type.label})`;
    }
    const confirmed = await vscode.window.showInformationMessage(
      `Create "${title}" in ${where}?`,
      { modal: true, detail: 'Its description is the ticket\'s. The new issue is linked to the item.' },
      'Create',
    );
    if (confirmed !== 'Create') return undefined;
    const description = source.markup === 'jira' ? markdownToJira(markdown) : markdown;
    const issue = await source.create(target, title, description);
    void this.refresh();
    return { id: issue.id, source: issue.source, url: issue.url, title: issue.title };
  }

  /**
   * Asks for an issue to link an item to: one of the listed issues, or any other by its key (ABC-123, #42). Undefined
   * if cancelled.
   */
  async pickIssue(itemId: string, exclude: readonly string[]): Promise<IssueLink | undefined> {
    if (!this.states.length) {
      const choice = await vscode.window.showInformationMessage('Connect Jira or GitHub Issues to link items to their issues.', 'Connect…');
      if (choice) await this.manage();
      if (!this.states.length) return undefined;
    }
    type Item = vscode.QuickPickItem & { issue?: RemoteIssue; key?: string };
    const listed: Item[] = this.states.flatMap((s) => [
      { label: s.label, kind: vscode.QuickPickItemKind.Separator },
      ...s.issues
        .filter((i) => !exclude.includes(i.id))
        .map((i) => ({ label: `$(${s.config.kind === 'github' ? 'github' : 'issues'}) ${i.id}`, description: i.title, detail: i.statusName, issue: i })),
    ]);
    const pick = vscode.window.createQuickPick<Item>();
    pick.title = `Link ${itemId} to an Issue`;
    pick.placeholder = 'Search the issues, or type the key of another one (ABC-123, #42)';
    pick.matchOnDescription = true;
    pick.items = listed;
    pick.onDidChangeValue((v) => {
      const typed = v.trim();
      const known = listed.some((i) => i.issue?.id.toLowerCase() === typed.toLowerCase());
      const looksLikeKey = /^[A-Za-z][A-Za-z0-9_]*-\d+$|^#?\d+$/.test(typed);
      pick.items = looksLikeKey && !known ? [{ label: `$(link) Link ${typed}`, description: 'Look it up in the connected trackers', key: typed }, ...listed] : listed;
    });
    const chosen = await new Promise<Item | undefined>((resolve) => {
      pick.onDidAccept(() => {
        resolve(pick.selectedItems[0]);
        pick.hide();
      });
      pick.onDidHide(() => resolve(undefined));
      pick.show();
    });
    pick.dispose();
    if (!chosen) return undefined;
    const issue =
      chosen.issue ??
      (await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Looking up ${chosen.key}…` }, () => this.lookup(chosen.key!)));
    if (!issue) {
      void vscode.window.showWarningMessage(`${chosen.key} isn't in any connected tracker (or can't be read).`);
      return undefined;
    }
    if (exclude.includes(issue.id)) return undefined;
    return { id: issue.id, source: issue.source, url: issue.url, title: issue.title };
  }

  /** Reads every integration's issues (one read at a time; a refresh while reading waits for it). */
  refresh(): Promise<void> {
    this.loading ??= trackProgress('backlog', 'Reading issues from Jira and GitHub', async () => {
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
    });
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
