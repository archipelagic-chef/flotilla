import type { BacklogPriority, BacklogStatus } from '../backlog';

/** A connection to an issue tracker whose issues show in the backlog next to the local items. */
export type IntegrationConfig =
  | { kind: 'jira'; id: string; site: string; email: string; jql: string }
  | { kind: 'github'; id: string; owner: string; repo: string };

/** An issue from a tracker, as the backlog lists it. */
export interface RemoteIssue {
  /** As in branch names and tabs: "ABC-123", "GH-42". */
  id: string;
  title: string;
  status: BacklogStatus;
  /** The tracker's own status name ("In Review"). */
  statusName: string;
  priority?: BacklogPriority;
  url: string;
  /** Which integration it comes from. */
  source: string;
}

export interface RemoteComment {
  author: string;
  /** ISO 8601. */
  date: string;
  /** HTML (Jira renders it) or Markdown (GitHub). */
  body: string;
  format: 'html' | 'markdown';
}

export interface RemoteDetails {
  issue: RemoteIssue;
  /** As the tracker renders it (HTML) or writes it (Markdown). */
  description: string;
  format: 'html' | 'markdown';
  /** Plain-ish text of the description, for agents (Jira wiki markup, GitHub Markdown). */
  descriptionText: string;
  comments: RemoteComment[];
}

/** What every tracker offers the backlog. */
export interface IssueSource {
  readonly config: IntegrationConfig;
  readonly label: string;
  list(): Promise<RemoteIssue[]>;
  details(id: string): Promise<RemoteDetails>;
  comment(id: string, text: string): Promise<void>;
}

/** fetch, injectable for tests. */
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** How long a tracker gets to answer. */
export const TIMEOUT_MS = 20_000;

export async function fetchJson<T>(fetch: Fetch, url: string, init: { method?: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { Accept: 'application/json', ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: abort.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
    }
    return (await res.json()) as T;
  } catch (error) {
    if (abort.signal.aborted) throw new Error(`${new URL(url).host} didn't answer within ${TIMEOUT_MS / 1000} seconds.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
