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
  /** The tracker's own priority name ("P2", "Blocker"). */
  priorityName?: string;
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

/** A move in an issue's workflow, as the tracker offers it for the issue now. */
export interface RemoteTransition {
  id: string;
  /** The move's name ("Start review"). */
  name: string;
  /** The status it leads to ("In Review"), and its lane. */
  to: string;
  status: BacklogStatus;
  /** Fields the move requires that Flotilla can't fill in (it's done in the tracker then). */
  needs?: string[];
}

/** What can be changed on an issue from Flotilla: asked of the tracker, which knows the project's workflow and fields. */
export interface RemoteEditOptions {
  transitions: RemoteTransition[];
  /** The priorities it can have, by name; undefined if it has none or they can't be set. */
  priorities?: string[];
  canEditTitle: boolean;
  canEditDescription: boolean;
}

/** Where a new issue goes: a Jira project and issue type (GitHub has one place). */
export interface CreateTarget {
  project?: string;
  issueType?: string;
}

/** What every tracker offers the backlog. */
export interface IssueSource {
  readonly config: IntegrationConfig;
  readonly label: string;
  /** How comments and descriptions are written: Jira wiki markup, or Markdown. */
  readonly markup: 'jira' | 'markdown';
  list(): Promise<RemoteIssue[]>;
  details(id: string): Promise<RemoteDetails>;
  /** text in the tracker's markup. */
  comment(id: string, text: string): Promise<void>;
  editOptions(id: string): Promise<RemoteEditOptions>;
  transition(id: string, transition: string): Promise<void>;
  /** description in the tracker's markup; priority by name. */
  update(id: string, change: { title?: string; description?: string; priority?: string }): Promise<void>;
  create(target: CreateTarget, title: string, description: string): Promise<RemoteIssue>;
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
    // Some writes answer with no content (204).
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  } catch (error) {
    if (abort.signal.aborted) throw new Error(`${new URL(url).host} didn't answer within ${TIMEOUT_MS / 1000} seconds.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
