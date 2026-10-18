// A fake of GitHub's Actions API, for trying the CI/CD view offline: npm run fake-github.
// It answers the routes under /repos/{owner}/{repo}/actions that Flotilla calls, from memory. A branch's runs are made
// when they're first read, from the commits of a local repository (the playground, by default), and each run moves on
// by the clock: queued, then running, then done. Nothing is sent anywhere, and nothing is pushed.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4010;

/** How long a run waits before its jobs start, and how long its jobs then run. */
const QUEUE_MS = 6_000;
const RUN_MS = 25_000;
const HOUR_MS = 3_600_000;

/** The failing test output of the CI run that fails (what `npm test` prints when a test's assertion fails). */
const FAILING_TESTS = [
  '> app@1.0.0 test',
  '> vitest run',
  '',
  ' RUN  v2.1.4 /home/runner/work/app/app',
  '',
  ' ✓ tests/math.test.ts (2 tests) 4ms',
  ' ❯ tests/cart.test.ts (3 tests | 1 failed) 9ms',
  '   ✓ adds items',
  '   × totals the prices with tax 7ms',
  '',
  ' FAIL  tests/cart.test.ts > Cart > totals the prices with tax',
  'AssertionError: expected 10.79 to be 10.8 // Object.is equality',
  '',
  ' ❯ tests/cart.test.ts:14:23',
  '     12|   const cart = new Cart();',
  '     13|   cart.add({ price: 9.99, qty: 1 });',
  '     14|   expect(cart.total(0.08)).toBe(10.8);',
  '       |                       ^',
  '',
  ' Test Files  1 failed | 1 passed (2)',
  '      Tests  1 failed | 4 passed (5)',
  '   Start at  16:40:02',
  '   Duration  1.21s',
  '##[error]Process completed with exit code 1.',
];

const WORKFLOWS = [
  {
    id: 101,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    dispatch: false,
    jobs: [
      { name: 'test', steps: ['Set up job', 'Run actions/checkout@v4', 'Run actions/setup-node@v4', 'Install dependencies', 'Run tests', 'Complete job'], failsAt: 'Run tests' },
      { name: 'lint', steps: ['Set up job', 'Run actions/checkout@v4', 'Install dependencies', 'Run npm run lint', 'Complete job'] },
    ],
  },
  {
    id: 102,
    name: 'Deploy',
    path: '.github/workflows/deploy.yml',
    dispatch: true,
    jobs: [{ name: 'deploy', environment: 'production', steps: ['Set up job', 'Run actions/checkout@v4', 'Deploy to production', 'Complete job'] }],
  },
];

const iso = (ms) => new Date(ms).toISOString();
/** GitHub's log lines carry a time with 100-nanosecond digits. */
const stamp = (ms) => `${new Date(ms).toISOString().replace(/Z$/, '')}0000Z`;

const json = (status, body) => ({ status, body });
const notFound = () => json(404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });

/** The commit's subject, or undefined when the repository doesn't have the branch. */
function gitBranch(dir, branch) {
  const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const sha = run(['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]);
    return { sha, title: run(['log', '-1', '--format=%s', sha]) };
  } catch {
    return undefined;
  }
}

/**
 * Starts the fake on host:port (port 0 picks a free one). `repoDir` is a git repository whose branches the fake knows;
 * without it, every branch exists, with made-up commits. `now` is the clock (tests move it).
 */
export async function startFakeGitHub({ port = DEFAULT_PORT, host = '127.0.0.1', repoDir, now = () => Date.now() } = {}) {
  const runs = [];
  const jobs = new Map(); // job id → { run, index }
  const seeded = new Set(); // "owner/repo@branch", once its runs are made
  const numbers = new Map(); // "owner/repo#workflow id" → the last run_number
  let nextRunId = 1000;
  let nextJobId = 50_000;
  let base = '';

  /** The branch's commit: from the repository, or made up. Undefined when the repository lacks the branch. */
  const commitOf = (branch) => {
    if (!repoDir) return { sha: createHash('sha1').update(`fake:${branch}`).digest('hex'), title: `Work on ${branch}` };
    return gitBranch(repoDir, branch);
  };

  function addRun(repo, workflow, { branch, commit, event, createdAt, outcome }) {
    const key = `${repo}#${workflow.id}`;
    const number = (numbers.get(key) ?? 0) + 1;
    numbers.set(key, number);
    const run = {
      id: nextRunId++,
      repo,
      workflow,
      number,
      branch,
      sha: commit.sha,
      title: commit.title,
      event,
      outcome,
      attempt: 1,
      startedAt: createdAt,
      cancelledAt: undefined,
      jobIds: workflow.jobs.map(() => nextJobId++),
    };
    run.jobIds.forEach((id, index) => jobs.set(id, { run, index }));
    runs.push(run);
    return run;
  }

  /** A branch's first runs: two that went well, a deploy, and the CI run that starts now and fails in its tests. */
  function seedBranch(repo, branch) {
    const key = `${repo}@${branch}`;
    if (seeded.has(key)) return;
    const commit = commitOf(branch);
    if (!commit) return;
    seeded.add(key);
    const at = now();
    const [ci, deploy] = WORKFLOWS;
    addRun(repo, ci, { branch, commit, event: 'push', createdAt: at - 3 * HOUR_MS, outcome: 'success' });
    addRun(repo, ci, { branch, commit, event: 'push', createdAt: at - 2 * HOUR_MS, outcome: 'success' });
    addRun(repo, deploy, { branch, commit, event: 'workflow_dispatch', createdAt: at - HOUR_MS, outcome: 'success' });
    addRun(repo, ci, { branch, commit, event: 'push', createdAt: at, outcome: 'failure' });
  }

  /** A run's phase at a time: queued, in progress (with how far along), or completed. */
  function phase(run, at) {
    if (run.cancelledAt !== undefined) return { status: 'completed', conclusion: 'cancelled', fraction: 1 };
    const elapsed = at - run.startedAt;
    if (elapsed < QUEUE_MS) return { status: 'queued', conclusion: null, fraction: 0 };
    if (elapsed < QUEUE_MS + RUN_MS) return { status: 'in_progress', conclusion: null, fraction: (elapsed - QUEUE_MS) / RUN_MS };
    return { status: 'completed', conclusion: run.outcome, fraction: 1 };
  }

  /** Each step of a job at a time. A failing job's steps after the failure are skipped, but its last step still runs. */
  function stepsOf(run, index, at) {
    const def = run.workflow.jobs[index];
    const p = phase(run, at);
    const last = def.steps.length - 1;
    const failAt = run.outcome === 'failure' && p.status === 'completed' ? def.steps.indexOf(def.failsAt) : -1;
    return def.steps.map((name, i) => {
      const number = i + 1;
      if (p.status === 'queued') return { name, number, status: 'queued', conclusion: null };
      if (p.status === 'in_progress') {
        const current = Math.min(last, Math.floor(p.fraction * def.steps.length));
        if (i < current) return { name, number, status: 'completed', conclusion: 'success' };
        if (i === current) return { name, number, status: 'in_progress', conclusion: null };
        return { name, number, status: 'queued', conclusion: null };
      }
      if (run.cancelledAt !== undefined) return { name, number, status: 'completed', conclusion: 'cancelled' };
      if (failAt !== -1 && i === failAt) return { name, number, status: 'completed', conclusion: 'failure' };
      if (failAt !== -1 && i > failAt && i !== last) return { name, number, status: 'completed', conclusion: 'skipped' };
      return { name, number, status: 'completed', conclusion: 'success' };
    });
  }

  function jobJson(run, index, at) {
    const p = phase(run, at);
    const def = run.workflow.jobs[index];
    const steps = stepsOf(run, index, at);
    const started = run.startedAt + QUEUE_MS;
    const ended = run.cancelledAt ?? started + RUN_MS;
    const failed = steps.some((s) => s.conclusion === 'failure');
    const conclusion = p.status !== 'completed' ? null : run.cancelledAt !== undefined ? 'cancelled' : failed ? 'failure' : 'success';
    return {
      id: run.jobIds[index],
      run_id: run.id,
      run_attempt: run.attempt,
      name: def.environment ? `${def.name} (${def.environment})` : def.name,
      status: p.status,
      conclusion,
      created_at: iso(run.startedAt),
      started_at: p.status === 'queued' ? null : iso(started),
      completed_at: p.status === 'completed' ? iso(ended) : null,
      html_url: `https://github.com/${run.repo}/actions/runs/${run.id}/job/${run.jobIds[index]}`,
      steps: steps.map((s) => ({
        name: s.name,
        status: s.status,
        conclusion: s.conclusion,
        number: s.number,
        started_at: s.status === 'queued' ? null : iso(started),
        completed_at: s.status === 'completed' ? iso(ended) : null,
      })),
    };
  }

  /** The job's log, as GitHub keeps it: a timed line per output line, with each step in a group. */
  function logOf(run, index) {
    const def = run.workflow.jobs[index];
    let at = run.startedAt + QUEUE_MS;
    const lines = [];
    const line = (text) => {
      at += 150;
      lines.push(`${stamp(at)} ${text}`);
    };
    for (const name of def.steps) {
      line(`##[group]${name}`);
      line('##[endgroup]');
      const output = {
        'Set up job': ["Current runner version: '2.319.1'", 'Operating System: Ubuntu 24.04.1 LTS'],
        'Run actions/checkout@v4': [`Syncing repository: ${run.repo}`, `Checking out the ref ${run.branch}`],
        'Run actions/setup-node@v4': ['Found in cache @ /opt/hostedtoolcache/node/22.16.0/x64'],
        'Install dependencies': ['added 214 packages, and audited 215 packages in 6s', 'found 0 vulnerabilities'],
        'Run tests': run.outcome === 'failure' && def.failsAt === name ? FAILING_TESTS : ['Test Files  2 passed (2)', '     Tests  5 passed (5)'],
        'Run npm run lint': ['> app@1.0.0 lint', '> eslint .'],
        'Deploy to production': [`Deployed ${run.sha.slice(0, 7)} to production.`],
        'Complete job': ['Cleaning up orphan processes'],
      }[name] ?? [];
      for (const text of output) line(text);
    }
    return `${lines.join('\n')}\n`;
  }

  function runJson(run, at) {
    const p = phase(run, at);
    return {
      id: run.id,
      name: run.workflow.name,
      workflow_id: run.workflow.id,
      run_number: run.number,
      run_attempt: run.attempt,
      display_title: run.title,
      head_branch: run.branch,
      head_sha: run.sha,
      head_commit: { id: run.sha, message: run.title },
      event: run.event,
      status: p.status,
      conclusion: p.conclusion,
      html_url: `https://github.com/${run.repo}/actions/runs/${run.id}`,
      created_at: iso(run.startedAt),
      run_started_at: iso(run.startedAt),
      updated_at: iso(at),
    };
  }

  const workflowJson = (wf, repo) => ({
    id: wf.id,
    name: wf.name,
    path: wf.path,
    state: 'active',
    created_at: '2026-10-01T09:00:00Z',
    updated_at: '2026-10-01T09:00:00Z',
    html_url: `https://github.com/${repo}/blob/main/${wf.path}`,
  });

  const findWorkflow = (key) => WORKFLOWS.find((wf) => (/^\d+$/.test(key) ? wf.id === Number(key) : wf.path.endsWith(`/${key}`)));
  const findRun = (repo, id) => runs.find((r) => r.repo === repo && r.id === Number(id));

  function listRuns(repo, query, at, workflow) {
    const branch = query.get('branch');
    if (branch) seedBranch(repo, branch);
    const event = query.get('event');
    const perPage = Math.min(100, Number(query.get('per_page')) || 30);
    const matching = runs
      .filter((r) => r.repo === repo && (!branch || r.branch === branch) && (!workflow || r.workflow.id === workflow.id) && (!event || r.event === event))
      .sort((a, b) => b.id - a.id);
    return json(200, { total_count: matching.length, workflow_runs: matching.slice(0, perPage).map((r) => runJson(r, at)) });
  }

  function dispatch(repo, workflow, body) {
    if (!workflow.dispatch) return json(422, { message: "Workflow does not have 'workflow_dispatch' trigger." });
    const branch = typeof body?.ref === 'string' ? body.ref : '';
    const commit = commitOf(branch);
    if (!commit) return json(422, { message: `No ref found for: ${branch}` });
    seedBranch(repo, branch);
    addRun(repo, workflow, { branch, commit, event: 'workflow_dispatch', createdAt: now(), outcome: 'success' });
    return { status: 204, body: undefined };
  }

  /** The actions API of one repository: `rest` is the path after /repos/{owner}/{repo}/actions. */
  function api({ method, repo, rest, query, at, body }) {
    let m;
    if (method === 'GET' && rest === '/workflows') return json(200, { total_count: WORKFLOWS.length, workflows: WORKFLOWS.map((wf) => workflowJson(wf, repo)) });
    if (method === 'GET' && (m = /^\/workflows\/([^/]+)$/.exec(rest))) {
      const wf = findWorkflow(m[1]);
      return wf ? json(200, workflowJson(wf, repo)) : notFound();
    }
    if (method === 'GET' && (m = /^\/workflows\/([^/]+)\/runs$/.exec(rest))) {
      const wf = findWorkflow(m[1]);
      return wf ? listRuns(repo, query, at, wf) : notFound();
    }
    if (method === 'POST' && (m = /^\/workflows\/([^/]+)\/dispatches$/.exec(rest))) {
      const wf = findWorkflow(m[1]);
      return wf ? dispatch(repo, wf, body) : notFound();
    }
    if (method === 'GET' && rest === '/runs') return listRuns(repo, query, at);
    if (method === 'GET' && (m = /^\/runs\/(\d+)$/.exec(rest))) {
      const run = findRun(repo, m[1]);
      return run ? json(200, runJson(run, at)) : notFound();
    }
    if (method === 'GET' && (m = /^\/runs\/(\d+)\/jobs$/.exec(rest))) {
      const run = findRun(repo, m[1]);
      if (!run) return notFound();
      const list = run.workflow.jobs.map((_, i) => jobJson(run, i, at));
      return json(200, { total_count: list.length, jobs: list });
    }
    if (method === 'POST' && (m = /^\/runs\/(\d+)\/(rerun|rerun-failed-jobs)$/.exec(rest))) {
      const run = findRun(repo, m[1]);
      if (!run) return notFound();
      if (phase(run, at).status !== 'completed') return json(409, { message: 'Cannot rerun a workflow run that is still going.' });
      run.attempt += 1;
      run.startedAt = at;
      run.cancelledAt = undefined;
      return json(201, {});
    }
    if (method === 'POST' && (m = /^\/runs\/(\d+)\/cancel$/.exec(rest))) {
      const run = findRun(repo, m[1]);
      if (!run) return notFound();
      if (phase(run, at).status === 'completed') return json(409, { message: 'Cannot cancel a workflow run that has completed.' });
      run.cancelledAt = at;
      return json(202, {});
    }
    if (method === 'GET' && (m = /^\/jobs\/(\d+)$/.exec(rest))) {
      const job = jobs.get(Number(m[1]));
      return job && job.run.repo === repo ? json(200, jobJson(job.run, job.index, at)) : notFound();
    }
    if (method === 'GET' && (m = /^\/jobs\/(\d+)\/logs$/.exec(rest))) {
      const job = jobs.get(Number(m[1]));
      if (!job || job.run.repo !== repo) return notFound();
      // Like GitHub: the log is at another address (here, on this server, over plain http), so the token isn't sent to it.
      return { status: 302, headers: { Location: `${base}/logs/${m[1]}` }, body: undefined };
    }
    return notFound();
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://fake.invalid');
    const method = req.method ?? 'GET';
    let result;
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : undefined;
      const logs = /^\/logs\/(\d+)$/.exec(url.pathname);
      const repos = /^\/repos\/([^/]+)\/([^/]+)\/actions(\/.*)?$/.exec(url.pathname);
      if (logs && method === 'GET') {
        const job = jobs.get(Number(logs[1]));
        result = job ? { status: 200, text: logOf(job.run, job.index) } : notFound();
      } else if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/deployments$/.test(url.pathname)) {
        // The CI/CD view also reads a branch's deployments (BL-8): the playground has none.
        result = json(200, []);
      } else if (repos) {
        const repo = `${decodeURIComponent(repos[1])}/${decodeURIComponent(repos[2])}`;
        result = api({ method, repo, rest: repos[3] ?? '', query: url.searchParams, at: now(), body });
      } else {
        result = notFound();
      }
    } catch (error) {
      result = json(error instanceof SyntaxError ? 400 : 500, { message: error instanceof Error ? error.message : String(error) });
    }
    if (result.text !== undefined) {
      res.writeHead(result.status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(result.text);
    } else if (result.body === undefined) {
      // No content (204), or a redirect.
      res.writeHead(result.status, result.headers);
      res.end();
    } else {
      res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result.body));
    }
  }

  const server = http.createServer((req, res) => void handle(req, res));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  base = `http://${host}:${address.port}`;
  return {
    url: base,
    /** Seeds a branch's runs now, as the first read does (for tests). */
    seed: (repo, branch) => seedBranch(repo, branch),
    // Kept-alive connections (a VS Code window's) would hold the server open.
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

// npm run fake-github: serves the playground's branches (or made-up ones, without the playground) until Ctrl+C.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoDir = path.resolve('.playground');
  const fake = await startFakeGitHub({
    port: Number(process.env.PORT ?? DEFAULT_PORT),
    repoDir: fs.existsSync(path.join(repoDir, '.git')) ? repoDir : undefined,
  });
  console.log(`Fake GitHub Actions API at ${fake.url}, for flotilla.dev.githubApi. Ctrl+C stops it.`);
}
