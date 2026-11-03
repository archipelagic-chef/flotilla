import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const settings: Record<string, unknown> = {};
vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (k: string, d: unknown) => (k in settings ? settings[k] : k === 'agents.lean' ? false : d) }) },
  extensions: { getExtension: () => undefined },
  window: { createTerminal: () => ({ show: () => undefined, exitStatus: undefined }) },
  ThemeIcon: class {},
}));

import {
  agentCommand,
  runAgentHeadless,
  setAgentDirs,
  setSecurityPolicy,
} from '../../../src/ui/backlog/agentRunner';
import { sandboxName } from '../../../src/features/sandbox/openshell';
import {
  defaultPolicy,
  PolicyStore,
} from '../../../src/features/sandbox/policy';
import {
  initRepo,
  makeTempDir,
} from '../../helpers/gitRepo';

/**
 * A stand-in for openshell: logs each call, and acts as a gateway that's up (or not, FAKE_GATEWAY=down) with no sandbox
 * until one is created. The agent's run prints a result.
 */
function fakeOpenShell(): { bin: string; log: string } {
  const bin = makeTempDir();
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(
    path.join(bin, 'openshell'),
    `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "status ") [ "$FAKE_GATEWAY" = down ] && { echo "connection refused" >&2; exit 1; }; exit 0 ;;
  "provider get") exit 1 ;;
  "provider create") exit 0 ;;
  "sandbox create") touch "${bin}/created"; exit 0 ;;
  "sandbox delete") exit 0 ;;
  "sandbox exec")
    case "$*" in
      *"-- true") [ -f "${bin}/created" ] || exit 1; exit 0 ;;
      *"command -v claude"*) exit 0 ;;
      *"-- claude "*) echo '{"result":"done in the sandbox"}'; exit 0 ;;
    esac ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  return { bin, log };
}

const output = {
  lines: [] as string[],
  appendLine(l: string) {
    this.lines.push(l);
  },
};
const savedPath = process.env.PATH;

beforeEach(() => {
  output.lines = [];
  settings['agents.sandbox'] = 'openshell';
});
afterEach(() => {
  process.env.PATH = savedPath;
  delete process.env.FAKE_GATEWAY;
  for (const k of Object.keys(settings)) delete settings[k];
  setAgentDirs([]);
});

describe('agents in OpenShell sandboxes (BL-270)', () => {
  it('starts the same claude on this machine when the sandbox is off', () => {
    settings['agents.sandbox'] = 'none';
    settings['agents.claudePath'] = '/opt/claude';
    const cmd = agentCommand(['-p', 'x'], '/somewhere');
    expect(cmd).toMatchObject({ command: '/opt/claude', args: ['-p', 'x'] });
    expect(cmd.sandbox).toBeUndefined();
  });

  it("runs an agent in its worktree's sandbox, made on its first start, with its folders mounted", async () => {
    const { bin, log } = fakeOpenShell();
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    const repo = await initRepo();
    const backlog = makeTempDir();
    setAgentDirs([backlog]);
    const run = runAgentHeadless({ cwd: repo, prompt: 'Do it', name: 'Watt-4', output: output as never });
    const result = await run.done;
    expect(result.reply).toBe('done in the sandbox');
    const name = sandboxName(repo);
    expect(output.lines[0]).toContain(`sandboxed in OpenShell sandbox ${name}`);
    const calls = fs.readFileSync(log, 'utf8').split('\n');
    expect(calls).toContain('status');
    expect(calls.find((c) => c.startsWith('provider create'))).toContain('--type claude-code');
    const create = calls.find((c) => c.startsWith('sandbox create'))!;
    expect(create).toContain(`--name ${name}`);
    expect(create).toContain(`"source":"${repo}"`);
    expect(create).toContain(`"source":"${backlog}"`);
    expect(create).toContain('--no-bootstrap');
    const exec = calls.find((c) => c.includes('-- claude '))!;
    expect(exec).toContain(`sandbox exec -n ${name} --workdir ${repo} --no-tty`);
    expect(exec).toContain(`--session-id ${run.sessionId}`);
  });

  it("doesn't start an agent at all when OpenShell's gateway is down, and says how to fix it", async () => {
    const { bin, log } = fakeOpenShell();
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    process.env.FAKE_GATEWAY = 'down';
    const repo = await initRepo();
    const result = await runAgentHeadless({ cwd: repo, prompt: 'Do it', name: 'Watt-4', output: output as never }).done;
    expect(result.code).toBe(125);
    expect(result.error).toContain("OpenShell's gateway isn't running");
    expect(result.error).toContain('openshell gateway start');
    expect(fs.readFileSync(log, 'utf8')).not.toContain('claude');
  });

  it("doesn't start an agent when OpenShell's CLI is missing", async () => {
    // A PATH with sh but no openshell.
    process.env.PATH = '/usr/bin:/bin';
    const repo = await initRepo();
    const result = await runAgentHeadless({ cwd: repo, prompt: 'Do it', name: 'Watt-4', output: output as never }).done;
    expect(result.code).toBe(125);
    expect(result.error).toContain("OpenShell's CLI (openshell) isn't on the PATH");
  });

  it('keeps the policy outside every folder the sandbox mounts, and starts the sandbox on the policy saved in the panel (BL-271)', async () => {
    const repo = await initRepo();
    const backlog = makeTempDir();
    setAgentDirs([backlog]);
    // VS Code's storage, as the extension gives it: neither in a worktree nor the backlog folder.
    const storage = makeTempDir();
    const store = new PolicyStore(path.join(storage, 'globalStorage'), path.join(storage, 'workspaceStorage'), () => defaultPolicy());
    store.write('all', { ...defaultPolicy(), network: [{ host: 'example.org', port: 443 }] });
    setSecurityPolicy(() => store.read(), path.join(storage, 'globalStorage', 'openshell'));
    const cmd = agentCommand(['-p', 'x'], repo);
    const mounts = (JSON.parse(cmd.env.FLOTILLA_SANDBOX_MOUNTS!) as { docker: { mounts: { source: string }[] } }).docker.mounts.map((m) => m.source);
    const policyFile = cmd.env.FLOTILLA_SANDBOX_POLICY!;
    const inside = (p: string, dir: string) => !path.relative(dir, p).startsWith('..');
    for (const file of [policyFile, store.file('all'), store.file('repository')]) {
      for (const mount of mounts) expect(inside(file, mount), `${file} in ${mount}`).toBe(false);
    }
    expect(fs.readFileSync(policyFile, 'utf8')).toContain('host: "example.org", port: 443');
  });
});
