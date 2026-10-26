// Types for scripts/fake-github.mjs, for the tests.
export const DEFAULT_PORT: number;

export interface FakeGitHubOptions {
  port?: number;
  host?: string;
  /** A git repository whose branches the fake knows (their commits are the runs' commits). */
  repoDir?: string;
  /** The clock, in milliseconds since the epoch. */
  now?: () => number;
  /** How long it takes to answer an action (a POST: re-run, cancel, dispatch), as GitHub does; 0 by default. */
  actionDelayMs?: number;
  /** A branch pushed to repoDir's origin after the fake started gets a CI run of each push (BL-222); off by default. */
  runsOnPush?: boolean;
}

/** The delay the demo window's and npm run fake-github's fake answer actions after. */
export const ACTION_DELAY_MS: number;

export interface FakeComment {
  id: number;
  kind: 'issue' | 'review';
  login: string;
  body: string;
  createdAt: number;
  path?: string;
  line?: number;
  inReplyTo?: number;
}

export interface FakeGitHub {
  /** The address to give Flotilla (flotilla.dev.githubApi). */
  url: string;
  /** Makes a branch's runs now, as the first read does. */
  seed(repo: string, branch: string): void;
  /** The pull requests it keeps (BL-221), with the comments made on them. */
  pulls(): Array<{
    repo: string;
    number: number;
    head: string;
    base: string;
    title: string;
    body: string;
    state: 'open' | 'closed';
    mergedAt?: number;
    /** The bodies of the comments in its conversation. */
    comments: string[];
    /** All its comments (BL-224), in its conversation (issue) and on lines of its diff (review). */
    allComments: FakeComment[];
    /** The reviews posted on it (BL-223), with their line comments. */
    reviews: Array<{
      id: number;
      event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
      body: string;
      comments: Array<{ path: string; line: number; start_line?: number; body: string }>;
      commit: string;
    }>;
  }>;
  /** Someone comments on a pull request, as on GitHub (the latest open one when none is named, or a ticket's: its branch has its id): its comment's id. */
  comment(o: { body: string; login?: string; repo?: string; number?: number; ticket?: string; path?: string; line?: number; inReplyTo?: number }): number;
  close(): Promise<void>;
}

export function startFakeGitHub(options?: FakeGitHubOptions): Promise<FakeGitHub>;
