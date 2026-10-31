import {
  type BacklogStatus,
  priorityFromName,
} from '../backlog';
import {
  type CreateTarget,
  type Fetch,
  fetchJson,
  type IntegrationConfig,
  type IssueSource,
  type RemoteDetails,
  type RemoteEditOptions,
  type RemoteIssue,
  TIMEOUT_MS,
} from './source';

type JiraConfig = Extract<IntegrationConfig, { kind: 'jira' }>;

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status?: { name: string; statusCategory?: { key: string } };
    priority?: { name?: string } | null;
    description?: string | null;
    comment?: { comments: JiraComment[] };
  };
  renderedFields?: { description?: string | null; comment?: { comments: JiraComment[] } };
}

interface JiraComment {
  author?: { displayName?: string };
  created: string;
  body: string;
}

interface JiraField {
  name?: string;
  fieldId?: string;
  required?: boolean;
  hasDefaultValue?: boolean;
  allowedValues?: Array<{ id?: string; name?: string }>;
}

interface JiraTransition {
  id: string;
  name: string;
  to?: { name?: string; statusCategory?: { key?: string } };
  fields?: Record<string, JiraField>;
}

/** Fields Flotilla fills in itself when it creates an issue. */
const FILLED_ON_CREATE = new Set(['project', 'issuetype', 'summary', 'description', 'reporter']);

/** The required fields without a default: what a transition or a new issue needs that Flotilla can't give. */
export function missingFields(fields: Iterable<[string, JiraField]>, filled: ReadonlySet<string> = new Set()): string[] {
  return [...fields].filter(([id, f]) => f.required && !f.hasDefaultValue && !filled.has(id)).map(([id, f]) => f.name ?? id);
}

/** Jira's status categories: To Do (new), In Progress (indeterminate), Done. */
export function jiraStatus(category: string | undefined, name = ''): BacklogStatus {
  if (category === 'done') return 'done';
  // Jira has no review category: review-like statuses ("In Review", "Code Review", "QA", "Testing") are in progress.
  if (category === 'indeterminate') return /review|\bqa\b|test|verif|approv/i.test(name) ? 'review' : 'doing';
  return 'todo';
}

/** Jira Cloud, with an API token (https://id.atlassian.com/manage-profile/security/api-tokens). */
export class JiraSource implements IssueSource {
  readonly label: string;
  readonly markup = 'jira';
  private readonly site: string;

  constructor(
    readonly config: JiraConfig,
    private readonly token: string,
    private readonly fetch: Fetch,
  ) {
    this.site = config.site.replace(/\/+$/, '');
    this.label = `Jira ${new URL(this.site).hostname.split('.')[0]}`;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Basic ${Buffer.from(`${this.config.email}:${this.token}`).toString('base64')}` };
  }

  private issue(i: JiraIssue): RemoteIssue {
    return {
      id: i.key,
      title: i.fields.summary,
      status: jiraStatus(i.fields.status?.statusCategory?.key, i.fields.status?.name),
      statusName: i.fields.status?.name ?? '',
      priority: priorityFromName(i.fields.priority?.name ?? undefined),
      ...(i.fields.priority?.name ? { priorityName: i.fields.priority.name } : {}),
      url: `${this.site}/browse/${i.key}`,
      source: this.config.id,
    };
  }

  /** Jira's attachments (and other images on its site) need the login: fetched with it. */
  async image(src: string): Promise<{ type: string; data: Buffer } | undefined> {
    let url: URL;
    try {
      url = new URL(src, `${this.site}/`);
    } catch {
      return undefined;
    }
    if (url.origin !== new URL(this.site).origin) return undefined;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetch(url.toString(), { headers: { Accept: 'image/*', ...this.headers() }, signal: abort.signal });
      if (!res.ok || !res.arrayBuffer) return undefined;
      const type = res.headers?.get('content-type')?.split(';')[0].trim() ?? 'image/png';
      if (!type.startsWith('image/')) return undefined;
      const data = Buffer.from(await res.arrayBuffer());
      return data.length <= 10 * 1024 * 1024 ? { type, data } : undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async list(): Promise<RemoteIssue[]> {
    const params = new URLSearchParams({ jql: this.config.jql, fields: 'summary,status,priority', maxResults: '100' });
    const out = await fetchJson<{ issues: JiraIssue[] }>(this.fetch, `${this.site}/rest/api/3/search/jql?${params}`, { headers: this.headers() });
    return out.issues.map((i) => this.issue(i));
  }

  async details(id: string): Promise<RemoteDetails> {
    // API v2 gives the description as wiki text (for agents); renderedFields as HTML (for people).
    const params = new URLSearchParams({ fields: 'summary,status,priority,description,comment', expand: 'renderedFields' });
    const i = await fetchJson<JiraIssue>(this.fetch, `${this.site}/rest/api/2/issue/${encodeURIComponent(id)}?${params}`, { headers: this.headers() });
    const raw = i.fields.comment?.comments ?? [];
    const rendered = i.renderedFields?.comment?.comments ?? [];
    return {
      issue: this.issue(i),
      description: i.renderedFields?.description ?? '',
      format: 'html',
      descriptionText: i.fields.description ?? '',
      comments: raw.map((c, n) => ({
        author: c.author?.displayName ?? 'Someone',
        date: c.created,
        body: rendered[n]?.body ?? c.body,
        format: rendered[n] ? 'html' : 'markdown',
      })),
    };
  }

  async comment(id: string, text: string): Promise<void> {
    await fetchJson(this.fetch, `${this.site}/rest/api/2/issue/${encodeURIComponent(id)}/comment`, {
      method: 'POST',
      headers: this.headers(),
      body: { body: text },
    });
  }

  private issueUrl(id: string, rest = ''): string {
    return `${this.site}/rest/api/2/issue/${encodeURIComponent(id)}${rest}`;
  }

  /** The issue's workflow moves (from its project's workflow, as Jira offers them now) and its editable fields. */
  async editOptions(id: string): Promise<RemoteEditOptions> {
    const [t, meta] = await Promise.all([
      fetchJson<{ transitions?: JiraTransition[] }>(this.fetch, this.issueUrl(id, '/transitions?expand=transitions.fields'), { headers: this.headers() }),
      fetchJson<{ fields?: Record<string, JiraField> }>(this.fetch, this.issueUrl(id, '/editmeta'), { headers: this.headers() }),
    ]);
    const fields = meta?.fields ?? {};
    const priorities = fields.priority?.allowedValues?.map((v) => v.name).filter((n): n is string => !!n);
    return {
      transitions: (t?.transitions ?? []).map((x) => {
        const needs = missingFields(Object.entries(x.fields ?? {}));
        return {
          id: x.id,
          name: x.name,
          to: x.to?.name ?? x.name,
          status: jiraStatus(x.to?.statusCategory?.key, x.to?.name),
          ...(needs.length ? { needs } : {}),
        };
      }),
      ...(priorities?.length ? { priorities } : {}),
      canEditTitle: 'summary' in fields,
      canEditDescription: 'description' in fields,
    };
  }

  async transition(id: string, transition: string): Promise<void> {
    await fetchJson(this.fetch, this.issueUrl(id, '/transitions'), { method: 'POST', headers: this.headers(), body: { transition: { id: transition } } });
  }

  async update(id: string, change: { title?: string; description?: string; priority?: string }): Promise<void> {
    const fields: Record<string, unknown> = {};
    if (change.title !== undefined) fields.summary = change.title;
    if (change.description !== undefined) fields.description = change.description;
    if (change.priority !== undefined) fields.priority = { name: change.priority };
    await fetchJson(this.fetch, this.issueUrl(id), { method: 'PUT', headers: this.headers(), body: { fields } });
  }

  /** The projects issues can be created in. */
  async projects(): Promise<Array<{ key: string; name: string }>> {
    const out = await fetchJson<{ values?: Array<{ key: string; name: string }> }>(
      this.fetch,
      `${this.site}/rest/api/2/project/search?maxResults=100&orderBy=name`,
      {
        headers: this.headers(),
      },
    );
    return out?.values ?? [];
  }

  /** A project's issue types (not sub-tasks, which need a parent). */
  async issueTypes(project: string): Promise<Array<{ id: string; name: string }>> {
    const out = await fetchJson<{
      issueTypes?: Array<{ id: string; name: string; subtask?: boolean }>;
      values?: Array<{ id: string; name: string; subtask?: boolean }>;
    }>(this.fetch, `${this.site}/rest/api/2/issue/createmeta/${encodeURIComponent(project)}/issuetypes`, { headers: this.headers() });
    return (out?.issueTypes ?? out?.values ?? []).filter((t) => !t.subtask).map(({ id, name }) => ({ id, name }));
  }

  /** The fields a new issue of a type needs that Flotilla doesn't fill in (the project's own required fields). */
  async missingOnCreate(project: string, issueType: string): Promise<string[]> {
    const out = await fetchJson<{ fields?: JiraField[]; values?: JiraField[] }>(
      this.fetch,
      `${this.site}/rest/api/2/issue/createmeta/${encodeURIComponent(project)}/issuetypes/${encodeURIComponent(issueType)}?maxResults=200`,
      { headers: this.headers() },
    );
    return missingFields(
      (out?.fields ?? out?.values ?? []).map((f) => [f.fieldId ?? f.name ?? '', f]),
      FILLED_ON_CREATE,
    );
  }

  async create(target: CreateTarget, title: string, description: string): Promise<RemoteIssue> {
    if (!target.project || !target.issueType) throw new Error('Choose a Jira project and issue type.');
    const created = await fetchJson<{ key: string }>(this.fetch, `${this.site}/rest/api/2/issue`, {
      method: 'POST',
      headers: this.headers(),
      body: {
        fields: { project: { key: target.project }, issuetype: { id: target.issueType }, summary: title, ...(description.trim() ? { description } : {}) },
      },
    });
    return { id: created.key, title, status: 'todo', statusName: '', url: `${this.site}/browse/${created.key}`, source: this.config.id };
  }
}
