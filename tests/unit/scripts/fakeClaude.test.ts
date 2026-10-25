import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { parseTicket } from '../../../src/features/backlog/ticket';
import { parseVerdict, saysReadyForReview, saysWaitingForUser } from '../../../src/features/backlog/review';
import { parseUsageLimit } from '../../../src/features/backlog/limits';
import {
  git,
  initRepo,
  makeTempDir,
  removeDir,
} from '../../helpers/gitRepo';

const SCRIPT = fileURLToPath(new URL('../../../scripts/fake-claude.mjs', import.meta.url));

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

interface Setup {
  repo: string;
  worktree: string;
  ticket: string;
  session: string;
}

/** A repo with the item's worktree, and its ticket in the backlog the way Flotilla keeps it (the main checkout's). */
function setup(description: string, activity = ''): Setup {
  const repo = initRepo();
  cleanup.push(repo);
  const worktree = path.join(makeTempDir(), 'wt');
  cleanup.push(path.dirname(worktree));
  git(repo, 'worktree', 'add', '-q', '-b', 'feature/BL-33-try', worktree);
  const ticket = path.join(repo, '.flotilla', 'backlog', 'BL-33.md');
  fs.mkdirSync(path.dirname(ticket), { recursive: true });
  fs.writeFileSync(ticket, `# Try it\n\n${description}\n\n${activity ? `## Activity\n\n${activity}` : ''}`.trimEnd() + '\n');
  return { repo, worktree, ticket, session: crypto.randomUUID() };
}

const implementerPrompt = (ticket: string) =>
  `You are agent Ada-3, working on backlog item BL-33: "Try it".\n\nIts ticket is ${ticket}: Markdown with the title, the description, then an "## Activity" log.`;

const reviewerPrompt = (ticket: string) =>
  `You are agent Ada-2, working on backlog item BL-33: "Try it". You are its reviewer.\n\nAnother agent did the work. Review it: read the ticket ${ticket}.`;

/** Runs the fake as Flotilla does: `-p <prompt> --output-format json …`, in the worktree. */
function run(s: Setup, o: { prompt?: string; name?: string; resume?: boolean } = {}) {
  const args = [
    '-p',
    o.prompt ?? implementerPrompt(s.ticket),
    '--output-format',
    'json',
    '--permission-mode',
    'auto',
    '--name',
    o.name ?? 'Ada-3 · BL-33',
    ...(o.resume ? ['--resume', s.session] : ['--session-id', s.session]),
  ];
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: s.worktree, encoding: 'utf8' });
  // A run that crashes prints nothing: no JSON.
  const json = r.stdout.trim() ? (JSON.parse(r.stdout) as { is_error: boolean; result: string; session_id: string }) : undefined;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const activity = (s: Setup) => parseTicket(fs.readFileSync(s.ticket, 'utf8')).activity;
const commits = (s: Setup) => git(s.worktree, 'rev-list', '--count', 'HEAD');

describe('the fake claude', () => {
  it('commits a change as an implementer and reports it ready for review', () => {
    const s = setup('fake: wait 0s');
    const r = run(s);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ is_error: false, session_id: s.session });
    expect(git(s.worktree, 'log', '-1', '--format=%s')).toBe('BL-33: fake change 1 by Ada-3');
    expect(fs.readFileSync(path.join(s.worktree, 'fake-work', 'BL-33.txt'), 'utf8')).toMatch(/· Ada-3 · change 1\n$/);

    // What Flotilla reads from the ticket: the agent's entry, a ready report, with a "How to review" section.
    const last = activity(s).at(-1)!;
    expect(last.author).toBe('Agent Ada-3');
    expect(saysReadyForReview(last.body)).toBe(true);
    expect(last.body).toContain('#### How to review');
    expect(last.body).toMatch(/\[fake-work\/BL-33\.txt\]\(fake-work\/BL-33\.txt#L1\)/);
    expect(last.body).toContain('```sh');
  });

  it('adds a section to a ticket that has no activity yet, and goes on with a new change each run', () => {
    const s = setup('fake: wait 0s');
    run(s);
    run(s, { resume: true });
    expect(activity(s)).toHaveLength(2);
    expect(git(s.worktree, 'log', '--format=%s').split('\n')).toEqual(['BL-33: fake change 2 by Ada-3', 'BL-33: fake change 1 by Ada-3', 'initial']);
  });

  it('approves as a reviewer, and asks for changes once when the ticket says so', () => {
    const plain = setup('fake: wait 0s');
    run(plain, { prompt: reviewerPrompt(plain.ticket), name: 'Ada-2 · review BL-33' });
    expect(parseVerdict(activity(plain).at(-1)!.body)).toBe('approved');
    expect(activity(plain).at(-1)!.author).toBe('Agent Ada-2');

    const picky = setup('fake: wait 0s, changes');
    run(picky, { prompt: reviewerPrompt(picky.ticket), name: 'Ada-2 · review BL-33' });
    expect(parseVerdict(activity(picky).at(-1)!.body)).toBe('changes');
    // The next round (resumed) sees its own request and approves.
    run(picky, { prompt: 'Round 2: changes made.', name: 'Ada-2 · review BL-33', resume: true });
    expect(parseVerdict(activity(picky).at(-1)!.body)).toBe('approved');
  });

  it('asks for changes every time with "changes forever"', () => {
    const s = setup('fake: wait 0s, changes forever');
    run(s, { prompt: reviewerPrompt(s.ticket), name: 'Ada-2 · review BL-33' });
    run(s, { prompt: 'Round 2.', name: 'Ada-2 · review BL-33', resume: true });
    expect(activity(s).map((e) => parseVerdict(e.body))).toEqual(['changes', 'changes']);
  });

  it('asks first with "ask", and goes on once the user has answered in the ticket', () => {
    const s = setup('fake: wait 0s, ask');
    run(s);
    expect(commits(s)).toBe('1');
    expect(saysWaitingForUser(activity(s).at(-1)!.body)).toBe(true);

    fs.appendFileSync(s.ticket, '\n### 2026-10-12 18:00 · You\nOne line per run is fine.\n');
    run(s, { resume: true });
    expect(commits(s)).toBe('2');
    expect(saysReadyForReview(activity(s).at(-1)!.body)).toBe(true);
  });

  it('hits a usage limit on its first run that resets when told, and goes on when resumed', () => {
    const s = setup('fake: wait 0s, limit 2m');
    const first = run(s);
    expect(first.code).toBe(1);
    expect(first.json?.is_error).toBe(true);
    // Flotilla reads the reset from the output: about two minutes from now (plus its usual minute).
    const limit = parseUsageLimit(first.stdout, new Date());
    expect(limit).toMatchObject({ known: true, kind: 'usage' });
    expect(Math.round((limit!.until.getTime() - Date.now()) / 60_000)).toBe(3);
    expect(commits(s)).toBe('1');

    const resumed = run(s, { prompt: "Claude's usage limit stopped you; it has reset. Go on.", resume: true });
    expect(resumed.code).toBe(0);
    expect(commits(s)).toBe('2');
  });

  it('crashes on its first run without reporting, and goes on when resumed', () => {
    const s = setup('fake: wait 0s, crash');
    const first = run(s);
    expect(first.code).toBe(1);
    expect(first.stderr).toContain('crashed');
    expect(activity(s)).toHaveLength(0);
    expect(commits(s)).toBe('1');

    expect(run(s, { resume: true }).code).toBe(0);
    expect(activity(s).at(-1)!.body).toMatch(/Ready for review\.$/);
  });

  it('answers a run that names no ticket without touching anything', () => {
    const s = setup('fake: wait 0s');
    const r = run(s, { prompt: 'Say hello.', name: 'Ada-3' });
    expect(r.code).toBe(0);
    expect(r.json?.result).toContain('Fake Claude');
    expect(commits(s)).toBe('1');
    expect(activity(s)).toHaveLength(0);
  });

  // Flotilla spawns claudePath directly (no node in front), so the script must be executable itself.
  it.skipIf(process.platform === 'win32')('runs directly, as Flotilla spawns claudePath', () => {
    expect(() => fs.accessSync(SCRIPT, fs.constants.X_OK)).not.toThrow();
    const r = spawnSync(SCRIPT, ['-p', 'Say hello.', '--output-format', 'json'], { encoding: 'utf8' });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).result).toContain('Fake Claude');
  });
});
