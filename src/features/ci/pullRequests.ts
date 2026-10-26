import { gitHubName } from '../backlog/sources/github';
import { type Fetch, fetchJson } from '../backlog/sources/source';
import type { Verdict } from '../backlog/review';

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

/** A file a pull request changes, with its diff (none for a binary or too large one). */
export interface PullRequestFile {
  filename: string;
  patch?: string;
}

/** A review on a pull request (BL-223). */
export interface PullRequestReviewInfo {
  id: number;
  url: string;
  body: string;
}

/** A line comment of a review: on the new side of a file's diff, from start_line to line when it spans lines. */
export interface ReviewComment {
  path: string;
  line: number;
  start_line?: number;
  side: 'RIGHT';
  start_side?: 'RIGHT';
  body: string;
}

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

interface ApiReview {
  id: number;
  html_url: string;
  body?: string | null;
}

const API = 'https://api.github.com';
const PAGE = 100;
/** The most pages of a list read. */
const MAX_PAGES = 30;
/** Comments read of one kind on one pull request, at most (pages). */
const MAX_COMMENT_PAGES = 10;

const stateOf = (p: ApiPull): PullRequestState => (p.state === 'open' ? 'open' : p.merged_at ? 'merged' : 'closed');
const reviewInfo = (r: ApiReview): PullRequestReviewInfo => ({ id: r.id, url: r.html_url, body: r.body ?? '' });
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
    const read = async (kind: CommentKind, path: string): Promise<PullRequestComment[]> =>
      (await this.pages<ApiComment>(`${this.base}${path}`, MAX_COMMENT_PAGES)).map((c) => comment(kind, c));
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

  /** The files a pull request changes, with their diffs. */
  async files(n: number): Promise<PullRequestFile[]> {
    return this.pages<PullRequestFile>(`${this.base}/pulls/${number(n)}/files`);
  }

  async reviews(n: number): Promise<PullRequestReviewInfo[]> {
    return (await this.pages<ApiReview>(`${this.base}/pulls/${number(n)}/reviews`)).map(reviewInfo);
  }

  async review(n: number, o: { body: string; event: ReviewEvent; comments: ReviewComment[] }): Promise<PullRequestReviewInfo> {
    const body = { body: o.body, event: o.event, comments: o.comments };
    return reviewInfo(
      await fetchJson<ApiReview>(this.fetch, `${this.base}/pulls/${number(n)}/reviews`, { method: 'POST', headers: await this.headers(), body }),
    );
  }

  private async pages<T>(url: string, max = MAX_PAGES): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= max; page++) {
      const items = await fetchJson<T[]>(this.fetch, `${url}?per_page=${PAGE}&page=${page}`, { headers: await this.headers() });
      all.push(...items);
      if (items.length < PAGE) break;
    }
    return all;
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

/** A reviewer agent's review round, posted on the ticket's open pull requests (BL-223). */
export interface PullRequestReview {
  round: number;
  reviewer: string;
  verdict: Verdict;
  /** Its report: the ticket entry's key (LocalBacklog.entryKey). */
  entry: string;
  /** The pull requests it's posted on, with the review's id there. */
  posted?: Array<{ number: number; id: number; url: string }>;
  /** Posting it failed, and the ticket said so (once). */
  failed?: string;
}

/** The new side's line numbers of each hunk of a file's diff (the lines a review may comment on). */
export function diffHunks(patch: string | undefined): Array<Set<number>> {
  const hunks: Array<Set<number>> = [];
  let line = 0;
  for (const l of (patch ?? '').split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      line = Number(h[1]);
      hunks.push(new Set());
    } else if (hunks.length && !l.startsWith('-') && !l.startsWith('\\')) hunks[hunks.length - 1].add(line++);
  }
  return hunks;
}

/** A finding's link to a file's line or lines: [src/a.ts:42](src/a.ts#L42), or #L42-L60. */
const LINE_LINK = /\[[^\]]*\]\(<?([^)#\s>]+)>?#L(\d+)(?:-L?(\d+))?\)/g;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;

/** Where a finding's links point at a line in the diff: the comment's place, or undefined when none does. */
function placeOf(text: string, files: Map<string, Array<Set<number>>>): Omit<ReviewComment, 'body'> | undefined {
  for (const m of text.matchAll(LINE_LINK)) {
    const path = decodeURIComponent(m[1]).replace(/^\.?\//, '');
    const hunks = files.get(path);
    if (!hunks) continue;
    const start = Number(m[2]);
    const end = Math.max(start, Number(m[3] ?? m[2]));
    const hunk = hunks.find((h) => h.has(end)) ?? hunks.find((h) => h.has(start));
    if (!hunk) continue;
    const line = hunk.has(end) ? end : start;
    return line > start && hunk.has(start) ? { path, line, start_line: start, side: 'RIGHT', start_side: 'RIGHT' } : { path, line, side: 'RIGHT' };
  }
  return undefined;
}

/**
 * A report as a review: its findings (list items) that link a line in the pull request's diff become line comments
 * there; the rest stays in the body.
 */
export function reviewComments(report: string, files: PullRequestFile[]): { body: string; comments: ReviewComment[] } {
  const diff = new Map(files.map((f) => [f.filename, diffHunks(f.patch)]));
  const lines = report.split(/\r?\n/);
  const kept: string[] = [];
  const comments: ReviewComment[] = [];
  let fence = false;
  for (let n = 0; n < lines.length; n++) {
    const item = !fence && LIST_ITEM.exec(lines[n]);
    if (/^\s*(```|~~~)/.test(lines[n])) fence = !fence;
    if (!item) {
      kept.push(lines[n]);
      continue;
    }
    // The item, with its lines indented under it.
    const indent = item[1].length;
    let last = n;
    while (last + 1 < lines.length && lines[last + 1].trim() && /^\s*/.exec(lines[last + 1])![0].length > indent && !LIST_ITEM.exec(lines[last + 1])) last++;
    const text = [item[2], ...lines.slice(n + 1, last + 1).map((l) => l.trim())].join('\n');
    const place = placeOf(text, diff);
    if (place) {
      comments.push({ ...place, body: text });
      n = last;
    } else kept.push(lines[n]);
  }
  return {
    body: kept
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    comments,
  };
}

/** The hidden mark a review round's body carries, to find it posted already. */
export const reviewMark = (id: string, round: number): string => `<!-- flotilla-review ${id} round ${round} -->`;

const VERDICT_TEXT: Record<Verdict, string> = { approved: 'approved', changes: 'changes requested' };

/** A review round's body on GitHub: headed with its agent, round and verdict, then the report (and its mark). */
export function reviewBody(o: { id: string; round: number; reviewer: string; verdict: Verdict; report: string; comments: number }): string {
  const head = `**Review by agent ${o.reviewer}, round ${o.round}, on Flotilla ticket ${o.id}: ${VERDICT_TEXT[o.verdict]}.**`;
  const inDiff = o.comments ? `\n\n_${o.comments === 1 ? 'One finding is a comment' : `${o.comments} findings are comments`} on the lines it points at._` : '';
  return `${head}${inDiff}\n\n${o.report}\n\n${reviewMark(o.id, o.round)}`;
}

/**
 * Posts a review round on a pull request, once: when its mark is on a review there already (it was posted, and the
 * reload came before its id was kept), that one is it. GitHub refuses to approve or request changes on the user's own
 * pull request: then it's a comment review, which says the verdict.
 */
export async function postReview(
  client: Pick<GitHubPullRequests, 'files' | 'reviews' | 'review'>,
  pr: number,
  o: { id: string; round: number; reviewer: string; verdict: Verdict; report: string },
): Promise<PullRequestReviewInfo & { asComment?: boolean; existing?: boolean }> {
  const mark = reviewMark(o.id, o.round);
  const before = (await client.reviews(pr)).find((r) => r.body.includes(mark));
  if (before) return { ...before, existing: true };
  const { body, comments } = reviewComments(o.report, await client.files(pr));
  const review = { body: reviewBody({ ...o, report: body, comments: comments.length }), comments };
  try {
    return await client.review(pr, { ...review, event: o.verdict === 'approved' ? 'APPROVE' : 'REQUEST_CHANGES' });
  } catch (e) {
    if (!/^422\b[\s\S]*own pull request/i.test(e instanceof Error ? e.message : '')) throw e;
    return { ...(await client.review(pr, { ...review, event: 'COMMENT' })), asComment: true };
  }
}
