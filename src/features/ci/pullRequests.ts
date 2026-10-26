import { gitHubName } from '../backlog/sources/github';
import { type Fetch, fetchJson } from '../backlog/sources/source';

/**
 * A ticket's pull request on GitHub (BL-221): opened when its agent reports "Ready for review" and its branch is pushed,
 * merged by GitHub when main fast-forwards to its commits, closed by Flotilla when they landed otherwise.
 */

/** flotilla.github.pullRequests: auto opens them when origin is on GitHub. */
export type PullRequestSetting = 'auto' | 'off';

export type PullRequestState = 'open' | 'merged' | 'closed';

/** A branch's pull request, as kept on the item. */
export interface PullRequestInfo {
  branch: string;
  number: number;
  url: string;
  state: PullRequestState;
}

interface ApiPull {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  merged_at?: string | null;
  head: { ref: string };
}

const API = 'https://api.github.com';

const stateOf = (p: ApiPull): PullRequestState => (p.state === 'open' ? 'open' : p.merged_at ? 'merged' : 'closed');
const info = (p: ApiPull): PullRequestInfo => ({ branch: p.head.ref, number: p.number, url: p.html_url, state: stateOf(p) });

function number(n: number): number {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Not a pull request number: ${n}.`);
  return n;
}

/** The pull requests of one repository, through the user's GitHub sign-in in VS Code (or the fake GitHub's). */
export class GitHubPullRequests {
  constructor(
    readonly owner: string,
    readonly repo: string,
    private readonly token: () => Promise<string>,
    private readonly fetch: Fetch,
    /** The API's address: GitHub's, or the fake one (flotilla.dev.githubApi) in the debug window. */
    private readonly api = API,
  ) {
    if (!gitHubName(owner) || !gitHubName(repo)) throw new Error(`Not a GitHub repository: ${owner}/${repo}.`);
  }

  /** The open pull request of a branch of this repository, if it has one. */
  async openFor(branch: string): Promise<PullRequestInfo | undefined> {
    const head = encodeURIComponent(`${this.owner}:${branch}`);
    const pulls = await fetchJson<ApiPull[]>(this.fetch, `${this.base}/pulls?head=${head}&state=open&per_page=10`, { headers: await this.headers() });
    // GitHub filters by head; a fake (or a proxy) might not.
    const own = pulls.find((p) => p.head.ref === branch);
    return own && info(own);
  }

  async get(n: number): Promise<PullRequestInfo> {
    return info(await fetchJson<ApiPull>(this.fetch, `${this.base}/pulls/${number(n)}`, { headers: await this.headers() }));
  }

  async create(o: { branch: string; base: string; title: string; body: string }): Promise<PullRequestInfo> {
    const body = { head: o.branch, base: o.base, title: o.title, body: o.body };
    return info(await fetchJson<ApiPull>(this.fetch, `${this.base}/pulls`, { method: 'POST', headers: await this.headers(), body }));
  }

  /** Closes a pull request, with a comment first (when there's one to make). */
  async close(n: number, comment?: string): Promise<PullRequestInfo> {
    if (comment)
      await fetchJson(this.fetch, `${this.base}/issues/${number(n)}/comments`, { method: 'POST', headers: await this.headers(), body: { body: comment } });
    return info(
      await fetchJson<ApiPull>(this.fetch, `${this.base}/pulls/${number(n)}`, { method: 'PATCH', headers: await this.headers(), body: { state: 'closed' } }),
    );
  }

  private async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.token()}`, 'X-GitHub-Api-Version': '2022-11-28' };
  }

  private get base(): string {
    return `${this.api}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }
}

/** A branch's open pull request into base: the one it has, or a new one. */
export async function ensurePullRequest(
  client: Pick<GitHubPullRequests, 'openFor' | 'create'>,
  o: { branch: string; base: string; title: string; body: string },
): Promise<{ pr: PullRequestInfo; created: boolean }> {
  const open = await client.openFor(o.branch);
  if (open) return { pr: open, created: false };
  return { pr: await client.create(o), created: true };
}

/** A ticket's pull request's body: its "When it's done" lines (or its title, without them), and its id. */
export function pullRequestBody(id: string, title: string, whenDone: string | undefined): string {
  return `${whenDone ?? title}\n\nFlotilla ticket ${id}.`;
}

/**
 * Where a merged ticket's pull request stands, once main is on origin with the commit that landed: GitHub marks it
 * merged when origin's main has the pull request's own commits (main fast-forwarded to them). When it doesn't (they
 * differ: the branch was rewritten as it landed), it's closed with a comment naming the commit that did. Until then
 * (main not pushed yet, or GitHub not done), it's left as it is.
 */
export async function settleMerged(
  client: Pick<GitHubPullRequests, 'get' | 'close'>,
  pr: PullRequestInfo,
  landed: { commit: string; base: string; onOrigin: boolean; headOnOrigin: boolean },
): Promise<PullRequestInfo> {
  if (!landed.onOrigin) return pr;
  const now = await client.get(pr.number);
  if (now.state !== 'open' || landed.headOnOrigin) return now;
  return client.close(
    pr.number,
    `Landed on \`${landed.base}\` as ${landed.commit} through Flotilla's Merge to main, with other commits than this pull request's, so it's closed here.`,
  );
}

/** The ticket's note of a pull request it got. */
export function pullRequestNote(pr: PullRequestInfo, created: boolean): string {
  return created
    ? `Opened pull request [#${pr.number}](${pr.url}) for \`${pr.branch}\` on GitHub.`
    : `\`${pr.branch}\` has pull request [#${pr.number}](${pr.url}) on GitHub already: it's kept.`;
}
