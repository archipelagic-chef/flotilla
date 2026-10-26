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

/** A comment on a pull request: in its conversation (an issue comment), or on a line of its diff (a review comment). */
export interface PullRequestComment {
  id: number;
  kind: CommentKind;
  login: string;
  body: string;
  url: string;
  /** ISO date. */
  createdAt: string;
  /** A review comment's file and line (none for one on a line that's gone from the diff: its original line). */
  path?: string;
  line?: number;
  /** A review comment's reply: the comment of the thread it answers. */
  inReplyTo?: number;
}

export type CommentKind = 'issue' | 'review';

interface ApiComment {
  id: number;
  body?: string | null;
  html_url: string;
  created_at: string;
  user?: { login: string } | null;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  in_reply_to_id?: number;
}

const API = 'https://api.github.com';
const PAGE = 100;
/** Comments read of one kind on one pull request, at most. */
const MAX_PAGES = 10;

const stateOf = (p: ApiPull): PullRequestState => (p.state === 'open' ? 'open' : p.merged_at ? 'merged' : 'closed');
const comment = (kind: CommentKind, c: ApiComment): PullRequestComment => ({
  id: c.id,
  kind,
  login: c.user?.login ?? 'ghost',
  body: c.body ?? '',
  url: c.html_url,
  createdAt: c.created_at,
  ...(kind === 'review' && c.path ? { path: c.path } : {}),
  ...(kind === 'review' && (c.line ?? c.original_line) ? { line: (c.line ?? c.original_line)! } : {}),
  ...(c.in_reply_to_id ? { inReplyTo: c.in_reply_to_id } : {}),
});
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

  /** A pull request's comments (BL-224): its conversation's and its line comments, oldest first. */
  async comments(n: number): Promise<PullRequestComment[]> {
    const read = async (kind: CommentKind, path: string): Promise<PullRequestComment[]> => {
      const all: PullRequestComment[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const list = await fetchJson<ApiComment[]>(this.fetch, `${this.base}${path}?per_page=${PAGE}&page=${page}`, { headers: await this.headers() });
        all.push(...list.map((c) => comment(kind, c)));
        if (list.length < PAGE) break;
      }
      return all;
    };
    const [issue, review] = await Promise.all([read('issue', `/issues/${number(n)}/comments`), read('review', `/pulls/${number(n)}/comments`)]);
    return [...issue, ...review].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  }

  /** Comments on a pull request: in its conversation, or as a reply in a line comment's thread. */
  async addComment(n: number, body: string, inReplyTo?: number): Promise<PullRequestComment> {
    const o = { method: 'POST', headers: await this.headers(), body: { body } };
    return inReplyTo
      ? comment('review', await fetchJson<ApiComment>(this.fetch, `${this.base}/pulls/${number(n)}/comments/${number(inReplyTo)}/replies`, o))
      : comment('issue', await fetchJson<ApiComment>(this.fetch, `${this.base}/issues/${number(n)}/comments`, o));
  }

  async editComment(kind: CommentKind, id: number, body: string): Promise<void> {
    await fetchJson(this.fetch, `${this.base}/${kind === 'issue' ? 'issues' : 'pulls'}/comments/${number(id)}`, {
      method: 'PATCH',
      headers: await this.headers(),
      body: { body },
    });
  }

  async deleteComment(kind: CommentKind, id: number): Promise<void> {
    await fetchJson(this.fetch, `${this.base}/${kind === 'issue' ? 'issues' : 'pulls'}/comments/${number(id)}`, {
      method: 'DELETE',
      headers: await this.headers(),
    });
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

/**
 * A discarded ticket's pull request (BL-225): closed with a comment saying so, unless it isn't open any more on GitHub
 * (merged or closed there), when it's left as it is.
 */
export async function closeDiscarded(client: Pick<GitHubPullRequests, 'get' | 'close'>, pr: PullRequestInfo, id: string): Promise<PullRequestInfo> {
  const now = await client.get(pr.number);
  if (now.state !== 'open') return now;
  return client.close(
    pr.number,
    `Flotilla ticket ${id} was discarded as won't do, so it's closed here. Reopened and in review again, it gets a new pull request.`,
  );
}

/** The ticket's note of a pull request it got. */
export function pullRequestNote(pr: PullRequestInfo, created: boolean): string {
  return created
    ? `Opened pull request [#${pr.number}](${pr.url}) for \`${pr.branch}\` on GitHub.`
    : `\`${pr.branch}\` has pull request [#${pr.number}](${pr.url}) on GitHub already: it's kept.`;
}
