import type { BacklogStatus } from '../backlog';
import { fetchJson, type Fetch, type IntegrationConfig, type IssueSource, type RemoteDetails, type RemoteIssue } from './source';

type JiraConfig = Extract<IntegrationConfig, { kind: 'jira' }>;

interface JiraIssue {
  key: string;
  fields: { summary: string; status?: { name: string; statusCategory?: { key: string } }; description?: string | null; comment?: { comments: JiraComment[] } };
  renderedFields?: { description?: string | null; comment?: { comments: JiraComment[] } };
}

interface JiraComment {
  author?: { displayName?: string };
  created: string;
  body: string;
}

/** Jira's status categories: To Do (new), In Progress (indeterminate), Done. */
export function jiraStatus(category: string | undefined): BacklogStatus {
  return category === 'done' ? 'done' : category === 'indeterminate' ? 'doing' : 'todo';
}

/** Jira Cloud, with an API token (https://id.atlassian.com/manage-profile/security/api-tokens). */
export class JiraSource implements IssueSource {
  readonly label: string;
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
      status: jiraStatus(i.fields.status?.statusCategory?.key),
      statusName: i.fields.status?.name ?? '',
      url: `${this.site}/browse/${i.key}`,
      source: this.config.id,
    };
  }

  async list(): Promise<RemoteIssue[]> {
    const params = new URLSearchParams({ jql: this.config.jql, fields: 'summary,status', maxResults: '100' });
    const out = await fetchJson<{ issues: JiraIssue[] }>(this.fetch, `${this.site}/rest/api/3/search/jql?${params}`, { headers: this.headers() });
    return out.issues.map((i) => this.issue(i));
  }

  async details(id: string): Promise<RemoteDetails> {
    // API v2 gives the description as wiki text (for agents); renderedFields as HTML (for people).
    const params = new URLSearchParams({ fields: 'summary,status,description,comment', expand: 'renderedFields' });
    const i = await fetchJson<JiraIssue>(this.fetch, `${this.site}/rest/api/2/issue/${encodeURIComponent(id)}?${params}`, { headers: this.headers() });
    const raw = i.fields.comment?.comments ?? [];
    const rendered = i.renderedFields?.comment?.comments ?? [];
    return {
      issue: this.issue(i),
      description: i.renderedFields?.description ?? '',
      format: 'html',
      descriptionText: i.fields.description ?? '',
      comments: raw.map((c, n) => ({ author: c.author?.displayName ?? 'Someone', date: c.created, body: rendered[n]?.body ?? c.body, format: rendered[n] ? 'html' : 'markdown' })),
    };
  }

  async comment(id: string, text: string): Promise<void> {
    await fetchJson(this.fetch, `${this.site}/rest/api/2/issue/${encodeURIComponent(id)}/comment`, { method: 'POST', headers: this.headers(), body: { body: text } });
  }
}
