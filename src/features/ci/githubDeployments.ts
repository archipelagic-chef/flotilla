import { fetchJson, type Fetch } from '../backlog/sources/source';

/** Where a deployment is: in progress (also queued or pending), live, failed, or no longer live. */
export type DeploymentState = 'success' | 'failure' | 'in_progress' | 'inactive';

export interface CiDeployment {
  id: number;
  /** As GitHub names it: "staging", "production". */
  environment: string;
  state: DeploymentState;
  /** The commit it deploys. */
  sha: string;
  /** ISO 8601. */
  created: string;
  /** The deployment on GitHub (its environment's activity). */
  url: string;
  /** The deployed site (the latest status's environment_url), if it has one. */
  siteUrl?: string;
  /** The deploy's log (the latest status's log_url), if it has one. */
  logUrl?: string;
}

interface ApiDeployment {
  id: number;
  sha: string;
  environment: string;
  created_at: string;
}

interface ApiStatus {
  state: string;
  environment_url?: string | null;
  log_url?: string | null;
}

const API = 'https://api.github.com';

/** GitHub's deployment state as one of four. Queued and pending deployments are in progress; no status yet counts as such too. */
export function deploymentState(state: string | null | undefined): DeploymentState {
  switch (state) {
    case 'success':
      return 'success';
    case 'failure':
    case 'error':
      return 'failure';
    case 'inactive':
      return 'inactive';
    default:
      return 'in_progress';
  }
}

/** The latest deployment of each environment, newest first, out of a list of deployments in any order. */
export function latestPerEnvironment<T extends { environment: string; created_at: string }>(deployments: T[]): T[] {
  const newest = [...deployments].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const environments = new Set<string>();
  const latest: T[] = [];
  for (const d of newest) {
    if (environments.has(d.environment)) continue;
    environments.add(d.environment);
    latest.push(d);
  }
  return latest;
}

/** A link the view can open: http or https only (a site's URL comes from the API, and it's shown as a link). */
export function webUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** GitHub deployments of one repository, through the user's GitHub sign-in in VS Code. */
export class GitHubDeployments {
  constructor(
    readonly owner: string,
    readonly repo: string,
    private readonly token: () => Promise<string>,
    private readonly fetch: Fetch,
    /** The API's address: GitHub's, or the fake one (flotilla.dev.githubApi) in the debug window. */
    private readonly api = API,
  ) {
    // Names only, as in the Issues client: no paths into other API routes.
    const name = (n: string) => /^[A-Za-z0-9_.-]+$/.test(n) && n !== '.' && n !== '..';
    if (!name(owner) || !name(repo)) throw new Error(`Not a GitHub repository: ${owner}/${repo}.`);
  }

  private async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.token()}`, 'X-GitHub-Api-Version': '2022-11-28' };
  }

  private get base(): string {
    return `${this.api}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  /** The latest deployment of each environment a branch is deployed to; none when it isn't deployed anywhere. */
  async forBranch(branch: string): Promise<CiDeployment[]> {
    const headers = await this.headers();
    const deployments = await fetchJson<ApiDeployment[]>(this.fetch, `${this.base}/deployments?ref=${encodeURIComponent(branch)}&per_page=100`, { headers });
    const latest = latestPerEnvironment(deployments);
    return Promise.all(
      latest.map(async (d): Promise<CiDeployment> => {
        // The newest status comes first.
        const [status] = await fetchJson<ApiStatus[]>(this.fetch, `${this.base}/deployments/${d.id}/statuses?per_page=1`, { headers });
        return {
          id: d.id,
          environment: d.environment,
          state: deploymentState(status?.state),
          sha: d.sha,
          created: d.created_at,
          url: `https://github.com/${this.owner}/${this.repo}/deployments/activity_log?environment_filter=${encodeURIComponent(d.environment)}`,
          siteUrl: webUrl(status?.environment_url),
          logUrl: webUrl(status?.log_url),
        };
      }),
    );
  }
}
