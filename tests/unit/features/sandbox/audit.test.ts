import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  agentAt,
  auditPage,
  keepAudit,
  markRemoved,
  parseAuditLine,
  readAudit,
  readRegistry,
  recordRun,
} from '../../../../src/features/sandbox/audit';
import { logsArgs } from '../../../../src/features/sandbox/openshell';
import { makeTempDir } from '../../../helpers/gitRepo';

// Lines as OpenShell's docs show them: the CLI's (epoch seconds) and the log file's (ISO).
const DENIED =
  '[1775014132.690] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(64) -> httpbin.org:443 [policy:- engine:opa] [reason:no matching policy]';
const ALLOWED = '[1775014132.118] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] ALLOWED /usr/bin/curl(58) -> api.github.com:443 [policy:github_api engine:opa]';
const HTTP = '2026-04-01T04:04:32.190Z OCSF HTTP:POST [MED] DENIED POST https://api.github.com/user/repos [policy:github_api engine:opa]';
const PROC = '2026-04-01T04:04:33.000Z OCSF PROC:LAUNCH [INFO] sleep(49)';
const FILE = '2026-04-01T04:04:34.000Z OCSF FILE:OPEN [MED] DENIED /home/node/.ssh/id_rsa [reason:not in policy]';
const NOISE = [
  '[1775014113.058] [sandbox] [INFO ] [openshell_sandbox] Starting sandbox',
  '2026-04-01T04:04:13.065Z OCSF CONFIG:DISCOVERY [INFO] Server returned no policy; attempting local discovery',
  '2026-04-01T04:04:13.100Z OCSF NET:LISTEN [INFO] 10.200.0.1:3128',
];

describe("A sandbox's audit (BL-272)", () => {
  it('reads network, file and process entries, allowed or blocked, from both line formats', () => {
    expect(parseAuditLine(DENIED, 'sb')).toMatchObject({
      at: new Date(1775014132690).toISOString(),
      kind: 'network',
      target: 'httpbin.org:443',
      blocked: true,
      detail: '/usr/bin/curl · no matching policy',
    });
    expect(parseAuditLine(ALLOWED, 'sb')).toMatchObject({
      kind: 'network',
      target: 'api.github.com:443',
      blocked: false,
      detail: '/usr/bin/curl · policy github_api',
    });
    expect(parseAuditLine(HTTP, 'sb')).toMatchObject({
      at: '2026-04-01T04:04:32.190Z',
      kind: 'network',
      target: 'POST https://api.github.com/user/repos',
      blocked: true,
    });
    expect(parseAuditLine(PROC, 'sb')).toMatchObject({ kind: 'process', target: 'sleep', blocked: false });
    expect(parseAuditLine(FILE, 'sb')).toMatchObject({ kind: 'file', target: '/home/node/.ssh/id_rsa', blocked: true });
    for (const line of NOISE) expect(parseAuditLine(line, 'sb')).toBeUndefined();
  });

  it('gives an entry to the agent that started in the sandbox last before it', () => {
    const runs = {
      runs: [
        { agent: 'Nova-3', from: '2026-04-01T05:00:00.000Z' },
        { agent: 'Quill-5', from: '2026-04-01T04:00:00.000Z' },
      ],
    };
    expect(agentAt(runs, '2026-04-01T04:30:00.000Z')).toBe('Quill-5');
    expect(agentAt(runs, '2026-04-01T05:30:00.000Z')).toBe('Nova-3');
    // Before any run (a clock off by a little): the first.
    expect(agentAt(runs, '2026-04-01T03:00:00.000Z')).toBe('Quill-5');
    expect(agentAt(undefined, '2026-04-01T03:00:00.000Z')).toBeUndefined();
  });

  it('keeps each line once, linked to its ticket and agent, and keeps the runs after the sandbox is removed', () => {
    const dir = path.join(makeTempDir(), 'audit');
    recordRun(dir, 'sb', { ticket: 'BL-7', agent: 'Quill-5', at: new Date('2026-01-01T00:00:00Z') });
    const log = [DENIED, ALLOWED, ...NOISE, PROC].join('\n');
    expect(keepAudit(dir, 'sb', log)).toBe(3);
    // The gateway prints its buffer again: nothing new.
    expect(keepAudit(dir, 'sb', `${log}\n${HTTP}`)).toBe(1);
    const kept = readAudit(dir);
    expect(kept).toHaveLength(4);
    expect(kept.every((e) => e.ticket === 'BL-7' && e.agent === 'Quill-5' && e.sandbox === 'sb')).toBe(true);
    markRemoved(dir, 'sb');
    expect(readRegistry(dir).sb).toMatchObject({ ticket: 'BL-7', removed: true });
    expect(fs.readdirSync(dir).sort()).toEqual(['sandboxes.json', 'sb.jsonl']);
  });

  it('lists blocked entries first, newest first, filtered and in pages', () => {
    const entries = [DENIED, ALLOWED, HTTP, PROC, FILE].map((l, i) => ({ ...parseAuditLine(l, 'sb')!, ticket: 'BL-7', agent: i < 2 ? 'Quill-5' : 'Nova-3' }));
    const all = auditPage(entries, { ticket: 'BL-7' }, 2);
    expect(all).toMatchObject({ total: 5, blocked: 3, allowed: 2 });
    expect(all.entries.map((e) => e.target)).toEqual(['/home/node/.ssh/id_rsa', 'POST https://api.github.com/user/repos']);
    expect(auditPage(entries, { result: 'allowed' }, 10).entries.map((e) => e.kind)).toEqual(['process', 'network']);
    expect(auditPage(entries, { agent: 'Quill-5' }, 10).total).toBe(2);
    expect(auditPage(entries, { ticket: 'BL-8' }, 10).total).toBe(0);
  });

  it("reads a sandbox's log with openshell logs", () => {
    expect(logsArgs('flotilla-x-abc123')).toEqual(['logs', 'flotilla-x-abc123', '--source', 'sandbox']);
  });
});
