import { priorityFromName } from '../backlog';
import { fetchJson, type Fetch, type IntegrationConfig, type IssueSource, type RemoteDetails, type RemoteEditOptions, type RemoteIssue } from './source';

type GitHubConfig = Extract<IntegrationConfig, { kind: 'github' }>;

interface GitHubIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  html_url: string;
  body?: string | null;
  labels?: Array<{ name?: string } | string>;
  assignees?: unknown[];
  pull_request?: unknown;
}

interface GitHubComment {
  user?: { login?: string };
  created_at: string;
  body: string;
}

const API = 'https://api.github.com';

/** owner/repo of a GitHub remote URL (https or ssh), if it is one. */
export function gitHubRepo(remoteUrl: string): { owner: string; repo: string } | undefined {
  const m = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

/** A GitHub owner or repository name (no paths into other API routes). */
export const gitHubName = (n: string) => /^[A-Za-z0-9_.-]+$/.test(n) && n !== '.' && n !== '..';

/** "GH-42" for issue 42 (branch- and tab-friendly, like a Jira key). */
export const gitHubId = (n: number) => `GH-${n}`;

/** GitHub Issues of one repository, through the user's GitHub sign-in in VS Code. */
export class GitHubSource implements IssueSource {
  readonly label: string;
  readonly markup = 'markdown';

  constructor(
    readonly config: GitHubConfig,
    private readonly token: () => Promise<string>,
    private readonly fetch: Fetch,
  ) {
    // Names only (the config file is in the backlog's folder, which agents can write): no paths into other API routes.
    if (!gitHubName(config.owner) || !gitHubName(config.repo)) throw new Error(`Not a GitHub repository: ${config.owner}/${config.repo}.`);
    this.label = `GitHub ${config.owner}/${config.repo}`;
  }

  private async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.token()}`, 'X-GitHub-Api-Version': '2022-11-28' };
  }

  private get base(): string {
    return `${API}/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}`;
  }

  private issue(i: GitHubIssue): RemoteIssue {
    const labels = (i.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')).toLowerCase());
    const doing = labels.some((l) => /in.?progress|doing|wip/.test(l));
    const review = labels.some((l) => /review|\bqa\b/.test(l));
    return {
      id: gitHubId(i.number),
      title: i.title,
      status: i.state === 'closed' ? 'done' : review ? 'review' : doing ? 'doing' : 'todo',
      statusName: i.state === 'closed' ? 'Closed' : review ? 'In review' : doing ? 'In progress' : 'Open',
      // Priority labels: "priority: high", "P1", "urgent", "critical".
      priority: labels
        .filter((l) => /priority|^p[0-4]$|urgent|critical/.test(l))
        .map((l) => priorityFromName(l))
        .find(Boolean),
      url: i.html_url,
      source: this.config.id,
    };
  }

  private number(id: string): number {
    const n = Number(/^(?:GH-|#)?(\d+)$/i.exec(id.trim())?.[1]);
    if (!n) throw new Error(`'${id}' is not a GitHub issue.`);
    return n;
  }

  async list(): Promise<RemoteIssue[]> {
    const headers = await this.headers();
    const [open, closed] = await Promise.all(
      ['open', 'closed'].map((state) => fetchJson<GitHubIssue[]>(this.fetch, `${this.base}/issues?state=${state}&per_page=${state === 'open' ? 100 : 20}&sort=updated`, { headers })),
    );
    return [...open, ...closed].filter((i) => !i.pull_request).map((i) => this.issue(i));
  }

  async details(id: string): Promise<RemoteDetails> {
    const n = this.number(id);
    const headers = await this.headers();
    const [i, comments] = await Promise.all([
      fetchJson<GitHubIssue>(this.fetch, `${this.base}/issues/${n}`, { headers }),
      fetchJson<GitHubComment[]>(this.fetch, `${this.base}/issues/${n}/comments?per_page=100`, { headers }),
    ]);
    return {
      issue: this.issue(i),
      description: i.body ?? '',
      format: 'markdown',
      descriptionText: i.body ?? '',
      comments: comments.map((c) => ({ author: c.user?.login ?? 'someone', date: c.created_at, body: c.body, format: 'markdown' })),
    };
  }

  async comment(id: string, text: string): Promise<void> {
    await fetchJson(this.fetch, `${this.base}/issues/${this.number(id)}/comments`, { method: 'POST', headers: await this.headers(), body: { body: text } });
  }

  /** GitHub's workflow: open, or closed as completed or as not planned. Priorities are labels, not set from here. */
  async editOptions(id: string): Promise<RemoteEditOptions> {
    const i = await fetchJson<GitHubIssue>(this.fetch, `${this.base}/issues/${this.number(id)}`, { headers: await this.headers() });
    return {
      transitions:
        i.state === 'open'
          ? [
              { id: 'completed', name: 'Close as Completed', to: 'Closed', status: 'done' },
              { id: 'not_planned', name: 'Close as Not Planned', to: 'Closed', status: 'done' },
            ]
          : [{ id: 'reopen', name: 'Reopen', to: 'Open', status: 'todo' }],
      canEditTitle: true,
      canEditDescription: true,
    };
  }

  async transition(id: string, transition: string): Promise<void> {
    const body = transition === 'reopen' ? { state: 'open' } : { state: 'closed', state_reason: transition };
    await fetchJson(this.fetch, `${this.base}/issues/${this.number(id)}`, { method: 'PATCH', headers: await this.headers(), body });
  }

  async update(id: string, change: { title?: string; description?: string }): Promise<void> {
    const body: Record<string, string> = {};
    if (change.title !== undefined) body.title = change.title;
    if (change.description !== undefined) body.body = change.description;
    await fetchJson(this.fetch, `${this.base}/issues/${this.number(id)}`, { method: 'PATCH', headers: await this.headers(), body });
  }

  async create(_target: unknown, title: string, description: string): Promise<RemoteIssue> {
    const i = await fetchJson<GitHubIssue>(this.fetch, `${this.base}/issues`, { method: 'POST', headers: await this.headers(), body: { title, body: description } });
    return this.issue(i);
  }
}
