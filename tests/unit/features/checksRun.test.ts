import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  checksEnv,
  runInBackground,
} from '../../../src/features/backlog/checksRun';
import {
  makeTempDir,
  removeDir,
} from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('The checks in the background (BL-169)', () => {
  it('writes all of their output to the log and passes it on as it comes, with no terminal', async () => {
    const dir = makeTempDir();
    cleanup.push(dir);
    const log = path.join(dir, 'merges', 'BL-1', 'checks.log');
    const seen: string[] = [];
    const run = runInBackground(dir, `node -e "console.log('one'); console.error('two'); process.exit(3)"`, log, (t) => seen.push(t));
    const end = await run.done;
    expect(end).toMatchObject({ code: 3, stopped: false });
    expect(end.output).toContain('one');
    expect(seen.join('')).toContain('two');
    const text = fs.readFileSync(log, 'utf8');
    // The command heads the log, not the output (whose words a failure is read from).
    expect(text).toMatch(/> node -e[\s\S]*one[\s\S]*two/);
    expect(end.output).not.toContain('node -e');
  });

  it.skipIf(process.platform === 'win32')('Stop stops the command and what its shell started', async () => {
    const dir = makeTempDir();
    cleanup.push(dir);
    const pidFile = path.join(dir, 'pid');
    // The shell starts a node that writes its pid, then waits.
    const command = `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1000)"; echo after`;
    const run = runInBackground(dir, command, path.join(dir, 'checks.log'), () => undefined);
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);
    run.stop();
    const end = await run.done;
    expect(end).toMatchObject({ code: undefined, stopped: true });
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
    expect(end.output).not.toContain('after');
  });

  it("runs them in the extension's environment, in colour, without the markers that make test runners print for an agent", () => {
    const env = checksEnv({ PATH: '/bin', AI_AGENT: 'claude-code', CLAUDECODE: '1', HOME: '/h' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', FORCE_COLOR: '1' });
  });
});
