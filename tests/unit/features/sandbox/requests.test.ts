import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';
import type { AuditEntry } from '../../../../src/features/sandbox/audit';
import { defaultPolicy } from '../../../../src/features/sandbox/policy';
import {
  blockedNeed,
  decide,
  decisionEntry,
  forgetGrants,
  pendingRequests,
  readDecisions,
  requestOf,
  withRule,
  writeDecisions,
} from '../../../../src/features/sandbox/requests';
import { makeTempDir } from '../../../helpers/gitRepo';

const entry = (e: Partial<AuditEntry>): AuditEntry => ({
  at: '2026-11-04T10:00:00.000Z',
  sandbox: 'flotilla-bl-3',
  ticket: 'BL-3',
  agent: 'Vega-2',
  kind: 'network',
  target: 'registry.npmjs.org:443',
  blocked: true,
  key: Math.random().toString(36),
  ...e,
});

const none = { tickets: {}, once: {} };

describe('blocked requests (BL-273)', () => {
  it("reads a connection as its host, port and program, an HTTP request as its URL's host, a path as itself", () => {
    expect(requestOf({ kind: 'network', target: 'telemetry.example.com:443', detail: '/usr/bin/curl · no matching policy' })).toEqual({
      key: 'network:telemetry.example.com:443:/usr/bin/curl',
      kind: 'network',
      target: 'telemetry.example.com:443',
      host: 'telemetry.example.com',
      port: 443,
      program: '/usr/bin/curl',
    });
    expect(requestOf({ kind: 'network', target: 'POST https://paste.example.org/api', detail: 'no matching policy' })).toMatchObject({
      key: 'network:paste.example.org:443',
      target: 'paste.example.org:443',
    });
    expect(requestOf({ kind: 'file', target: '/home/node/.ssh/id_rsa' })).toEqual({
      key: 'file:/home/node/.ssh/id_rsa',
      kind: 'file',
      target: '/home/node/.ssh/id_rsa',
    });
    // A program run: no rule allows it.
    expect(requestOf({ kind: 'process', target: 'npm test' })).toBeUndefined();
  });

  it('asks once for a request tried again and again, oldest first, each ticket its own', () => {
    const pending = pendingRequests(
      [
        entry({ at: '2026-11-04T10:05:00.000Z', agent: 'Nova-7' }),
        entry({ at: '2026-11-04T10:01:00.000Z' }),
        entry({ at: '2026-11-04T10:00:00.000Z', kind: 'file', target: '/home/node/.ssh/id_rsa' }),
        entry({ ticket: 'BL-4', sandbox: 'flotilla-bl-4' }),
        entry({ blocked: false, target: 'api.github.com:443' }),
      ],
      none,
      defaultPolicy(),
    );
    expect(pending.get('BL-3')?.map((r) => [r.target, r.times])).toEqual([
      ['/home/node/.ssh/id_rsa', 1],
      ['registry.npmjs.org:443', 2],
    ]);
    // The last try's agent is the one the row names.
    expect(pending.get('BL-3')?.[1]).toMatchObject({ agent: 'Nova-7', since: '2026-11-04T10:01:00.000Z' });
    expect(pending.get('BL-4')).toHaveLength(1);
    expect(blockedNeed(pending.get('BL-3')!)).toEqual({
      kind: 'blocked',
      since: '2026-11-04T10:00:00.000Z',
      line: 'Blocked: Vega-2 opened /home/node/.ssh/id_rsa (1 more)',
    });
  });

  it("asks no more once decided for that ticket, allowed by the policy, or let through by its sandbox's Allow once", () => {
    const blocked = entry({});
    const r = pendingRequests([blocked], none, defaultPolicy()).get('BL-3')![0];
    expect(pendingRequests([blocked], decide(none, r, 'blocked'), defaultPolicy()).size).toBe(0);
    // Kept blocked for BL-3 only: another ticket's agent trying it asks again.
    expect(pendingRequests([blocked, entry({ ticket: 'BL-4' })], decide(none, r, 'blocked'), defaultPolicy()).get('BL-4')).toHaveLength(1);
    expect(pendingRequests([blocked], none, withRule(defaultPolicy(), r)).size).toBe(0);
    const once = decide(none, r, 'once');
    expect(once.once['flotilla-bl-3']).toEqual({ network: [{ host: 'registry.npmjs.org', port: 443 }], commands: [] });
    // The decision's own audit entry asks nothing.
    expect(pendingRequests([decisionEntry(r, 'blocked')], none, defaultPolicy()).size).toBe(0);
  });

  it('allows a connection by its host and program, and a path to be read', () => {
    const [net] = pendingRequests([entry({ detail: '/usr/bin/curl · no matching policy' })], none, defaultPolicy()).get('BL-3')!;
    const p = withRule(defaultPolicy(), net);
    expect(p.network).toContainEqual({ host: 'registry.npmjs.org', port: 443 });
    expect(p.commands).toContainEqual({ path: '/usr/bin/curl' });
    expect(withRule(p, net)).toEqual(p);
    // A program the policy's globs name already isn't added again.
    const [node] = pendingRequests([entry({ detail: '/usr/local/bin/node · no matching policy' })], none, defaultPolicy()).get('BL-3')!;
    expect(withRule(defaultPolicy(), node).commands).toEqual(defaultPolicy().commands);
    const [file] = pendingRequests([entry({ kind: 'file', target: '/data/docs/a.md' })], none, defaultPolicy()).get('BL-3')!;
    expect(withRule(defaultPolicy(), file).files).toContainEqual({ path: '/data/docs/a.md', access: 'read' });
    // A folder's rule covers what's in it.
    expect(
      pendingRequests([entry({ kind: 'file', target: '/data/docs/a.md' })], none, { ...defaultPolicy(), files: [{ path: '/data/docs/', access: 'read' }] })
        .size,
    ).toBe(0);
  });

  it("records the decision as the user's in the audit, and keeps Allow once until its sandbox is removed", () => {
    const [r] = pendingRequests([entry({})], none, defaultPolicy()).get('BL-3')!;
    expect(decisionEntry(r, 'once', new Date('2026-11-04T11:00:00.000Z'))).toMatchObject({
      agent: 'You',
      ticket: 'BL-3',
      sandbox: 'flotilla-bl-3',
      target: 'registry.npmjs.org:443',
      blocked: false,
      decision: 'once',
      detail: 'You allowed it once, in this sandbox',
    });
    const dir = makeTempDir();
    writeDecisions(dir, decide(none, r, 'once'));
    expect(readDecisions(dir).once['flotilla-bl-3']).toBeDefined();
    forgetGrants(dir, 'flotilla-bl-3');
    expect(readDecisions(dir).once).toEqual({});
    // The ticket's decision stays: it doesn't ask again.
    expect(readDecisions(dir).tickets['BL-3']?.[r.key]?.choice).toBe('once');
    expect(fs.existsSync(path.join(dir, 'decisions.json'))).toBe(true);
  });
});
