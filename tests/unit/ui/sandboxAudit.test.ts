import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  extensions: { getExtension: () => undefined },
  EventEmitter: class {
    private listeners: Array<() => void> = [];
    event = (l: () => void) => {
      this.listeners.push(l);
      return { dispose: () => undefined };
    };
    fire() {
      for (const l of this.listeners) l();
    }
    dispose() {}
  },
}));

import { removeSandboxOf } from '../../../src/ui/backlog/agentRunner';
import {
  auditDir,
  SandboxAudit,
} from '../../../src/ui/backlog/sandboxAudit';
import { readRegistry } from '../../../src/features/sandbox/audit';
import { sandboxName } from '../../../src/features/sandbox/openshell';
import { makeTempDir } from '../../helpers/gitRepo';

/** A stand-in for openshell: logs each call; `logs` prints a blocked and an allowed connection. */
function fakeOpenShell(): { bin: string; log: string } {
  const bin = makeTempDir();
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(
    path.join(bin, 'openshell'),
    `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  logs)
    echo "[1775014132.690] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(64) -> evil.example.com:443 [policy:- engine:opa] [reason:no matching policy]"
    echo "[1775014133.000] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] ALLOWED /usr/bin/node(9) -> api.anthropic.com:443 [policy:claude engine:opa]"
    echo "[1775014134.000] [sandbox] [INFO ] [openshell_sandbox] Starting sandbox" ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  return { bin, log };
}

const savedPath = process.env.PATH;
let audit: SandboxAudit | undefined;
afterEach(() => {
  process.env.PATH = savedPath;
  audit?.dispose();
  audit = undefined;
});

describe("the sandboxed agents' audit (BL-272)", () => {
  it("keeps each repository's audit in a folder of its own in Flotilla's storage", () => {
    expect(auditDir('/store', '/a/.git')).not.toBe(auditDir('/store', '/b/.git'));
    expect(auditDir('/store', '/a/.git').startsWith(path.join('/store', 'audit'))).toBe(true);
  });

  it("copies a sandbox's log, linked to the agent that started there, and counts each ticket's blocked entries", async () => {
    const { bin } = fakeOpenShell();
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    audit = new SandboxAudit(path.join(makeTempDir(), 'audit'));
    const changed = vi.fn();
    audit.onDidChange(changed);
    audit.noteRun('sb', 'BL-7', 'Quill-5');
    // The agent started after these lines' time (2026-04-01): they're still its, the sandbox's first agent's.
    await audit.copyAll();
    expect(audit.entries().map((e) => [e.ticket, e.agent, e.target, e.blocked])).toEqual([
      ['BL-7', 'Quill-5', 'evil.example.com:443', true],
      ['BL-7', 'Quill-5', 'api.anthropic.com:443', false],
    ]);
    expect(audit.blockedByTicket()).toEqual(new Map([['BL-7', 1]]));
    expect(changed).toHaveBeenCalledTimes(1);
    // The same lines again: nothing new.
    await audit.copyAll();
    expect(audit.entries()).toHaveLength(2);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('copies the log before the sandbox of a removed worktree is deleted, and keeps it', async () => {
    const { bin, log } = fakeOpenShell();
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    const dir = path.join(makeTempDir(), 'audit');
    audit = new SandboxAudit(dir);
    const name = sandboxName('/repo/.worktrees/feature-BL-7');
    audit.noteRun(name, 'BL-7', 'Quill-5');
    removeSandboxOf('/repo/.worktrees/feature-BL-7');
    await vi.waitFor(() => expect(fs.readFileSync(log, 'utf8')).toContain('sandbox delete'), { timeout: 5000 });
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([`logs ${name} --source sandbox`, `sandbox delete ${name}`]);
    expect(readRegistry(dir)[name]?.removed).toBe(true);
    expect(audit.entries()).toHaveLength(2);
    // A removed sandbox is read no more.
    await audit.copyAll();
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2);
  });
});
