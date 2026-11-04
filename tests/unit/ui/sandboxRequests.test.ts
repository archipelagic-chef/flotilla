import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

let sandboxed = true;
vi.mock('vscode', () => ({
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

import {
  type AuditEntry,
  readAudit,
} from '../../../src/features/sandbox/audit';
import {
  defaultPolicy,
  PolicyStore,
} from '../../../src/features/sandbox/policy';
import { readDecisions } from '../../../src/features/sandbox/requests';
import { SandboxRequests } from '../../../src/ui/backlog/sandboxRequests';
import { makeTempDir } from '../../helpers/gitRepo';

function setup(entries: Partial<AuditEntry>[]) {
  const dir = makeTempDir();
  const audit = path.join(dir, 'audit');
  fs.mkdirSync(audit);
  fs.writeFileSync(
    path.join(audit, 'flotilla-bl-3.jsonl'),
    entries
      .map((e, i) =>
        JSON.stringify({ at: `2026-11-04T10:0${i}:00.000Z`, sandbox: 'flotilla-bl-3', ticket: 'BL-3', agent: 'Vega-2', blocked: true, key: `k${i}`, ...e }),
      )
      .join('\n') + '\n',
  );
  const store = new PolicyStore(path.join(dir, 'global'), path.join(dir, 'workspace'), () => defaultPolicy());
  let cache: AuditEntry[] | undefined;
  const fake = { dir: audit, entries: () => (cache ??= readAudit(audit)), refresh: () => (cache = undefined) };
  // No openshell on the PATH here: no sandbox is running, so the rules apply at the next start.
  const requests = new SandboxRequests(
    fake,
    store,
    () => ['flotilla-bl-3'],
    path.join(dir, 'policies'),
    () => sandboxed,
  );
  return { requests, store, audit };
}

describe('a blocked request asks the user (BL-273)', () => {
  it('Allow once lets only that sandbox reach it, and records it as your decision', async () => {
    const { requests, store, audit } = setup([{ kind: 'network', target: 'registry.npmjs.org:443' }]);
    const [r] = requests.pending().get('BL-3')!;
    expect((await requests.decide('BL-3', r.key, 'once')).done).toContain('once');
    expect(requests.pending().size).toBe(0);
    expect(requests.policyOf('flotilla-bl-3').network).toContainEqual({ host: 'registry.npmjs.org', port: 443 });
    expect(requests.policyOf('flotilla-bl-4').network).not.toContainEqual({ host: 'registry.npmjs.org', port: 443 });
    expect(store.saved()).toBe(false);
    expect(readAudit(audit).at(-1)).toMatchObject({ agent: 'You', decision: 'once', ticket: 'BL-3' });
  });

  it('Always allow adds it to the policy in force; a folder has no Allow once', async () => {
    const { requests, store } = setup([
      { kind: 'file', target: '/home/node/docs' },
      { kind: 'network', target: 'pypi.org:443', detail: '/usr/bin/curl · no matching policy' },
    ]);
    const [file, net] = requests.pending().get('BL-3')!;
    expect((await requests.decide('BL-3', file.key, 'once')).error).toContain('next start');
    expect((await requests.decide('BL-3', file.key, 'always')).done).toContain('next start');
    await requests.decide('BL-3', net.key, 'always');
    expect(store.read().files).toContainEqual({ path: '/home/node/docs', access: 'read' });
    expect(store.read().network).toContainEqual({ host: 'pypi.org', port: 443 });
    expect(store.read().commands).toContainEqual({ path: '/usr/bin/curl' });
  });

  it('Keep blocked asks no more, changes no rule, and only a request the audit has can be decided', async () => {
    const { requests, store, audit } = setup([{ kind: 'network', target: 'evil.example:443' }]);
    const [r] = requests.pending().get('BL-3')!;
    expect((await requests.decide('BL-3', 'network:anything.example:443', 'always')).error).toBeDefined();
    await requests.decide('BL-3', r.key, 'blocked');
    expect(requests.pending().size).toBe(0);
    expect(store.saved()).toBe(false);
    expect(readDecisions(audit).tickets['BL-3'][r.key].choice).toBe('blocked');
    sandboxed = false;
    expect(setup([{ kind: 'network', target: 'evil.example:443' }]).requests.pending().size).toBe(0);
    sandboxed = true;
  });
});
