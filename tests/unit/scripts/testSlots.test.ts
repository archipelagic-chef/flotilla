import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeChecksConfig } from '../../../src/features/backlog/checksConfig';
import {
  describeRun,
  mayStart,
  namesFiles,
  readQueue,
  slotCount,
  takeSlot,
  waitingLine,
  workersFor,
  type QueueEntry,
} from '../../../scripts/test.mjs';

const host = os.hostname();
const entry = (pid: number, o: Partial<QueueEntry> = {}): QueueEntry => ({ pid, host, label: `BL-${pid}`, first: false, since: pid, running: false, ...o });

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-slots-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('slots and workers', () => {
  it('gives 1 slot per 16 cores by default, at least 1, or the configured number', () => {
    expect(slotCount(32, undefined)).toBe(2);
    expect(slotCount(4, 0)).toBe(1);
    expect(slotCount(16, '3')).toBe(3);
    expect(slotCount(32, 'x')).toBe(2);
  });

  it('splits the cores between the slots', () => {
    expect(workersFor(16, 2)).toBe(8);
    expect(workersFor(16, 3)).toBe(5);
    expect(workersFor(2, 4)).toBe(1);
  });

  it('tells file filters from options and their values', () => {
    expect(namesFiles([])).toBe(false);
    expect(namesFiles(['-t', 'merges', '--reporter', 'dot'])).toBe(false);
    expect(namesFiles(['--reporter=dot', 'tests/unit/a.test.ts'])).toBe(true);
  });
});

describe('describeRun', () => {
  it("names an agent's run by its branch's ticket, and a merge's as going first", () => {
    expect(describeRun('/w/.worktrees/feature-BL-120-x', 'feature/BL-120-share-the-machine')).toEqual({ label: 'BL-120', first: false });
    expect(describeRun('/tmp/flotilla-merge/worktree_extension-BL-122-1a2b3c4d', 'HEAD')).toEqual({ label: 'BL-122 merge', first: true });
    expect(describeRun('/w/repo', 'main')).toEqual({ label: 'main', first: false });
  });
});

describe('mayStart', () => {
  it('waits while the runs going and the ones ahead fill the slots', () => {
    const me = entry(3);
    const r = mayStart([entry(1, { running: true }), entry(2), me, entry(4)], me, 2);
    expect(r.go).toBe(false);
    expect(waitingLine(r.ahead)).toBe('Waiting for 2 other test runs (BL-1, BL-2)…');
    expect(mayStart([entry(1, { running: true }), me, entry(4)], me, 2).go).toBe(true);
  });

  it("puts a merge's run ahead of the agents' waiting ones, not of the ones going", () => {
    const merge = entry(9, { first: true, label: 'BL-9 merge' });
    const r = mayStart([entry(1, { running: true }), entry(2), merge], merge, 1);
    expect(r.ahead.map((e) => e.label)).toEqual(['BL-1']);
    expect(mayStart([entry(2), merge], merge, 1).go).toBe(true);
    expect(mayStart([entry(2), merge], entry(2), 1).go).toBe(false);
  });
});

describe('readQueue', () => {
  it("removes the entries of processes that died, and of other hosts' after 2 hours", () => {
    const write = (name: string, e: QueueEntry) => fs.writeFileSync(path.join(tmp, name), JSON.stringify(e));
    write('a.json', entry(1));
    write('b.json', entry(2));
    write('c.json', entry(3, { host: 'elsewhere', since: 0 }));
    write('d.json', entry(4, { host: 'elsewhere', since: 3 * 60 * 60_000 }));
    const live = readQueue(tmp, 3 * 60 * 60_000 + 1, (pid) => pid === 1, host);
    expect(live.map((e) => e.pid).sort()).toEqual([1, 4]);
    expect(fs.readdirSync(tmp).sort()).toEqual(['a.json', 'd.json']);
  });
});

describe('takeSlot', () => {
  it("waits for a run going to end, saying who it waits for, then takes the slot", async () => {
    fs.writeFileSync(path.join(tmp, 'other.json'), JSON.stringify(entry(process.ppid, { running: true, label: 'BL-120', since: 0 })));
    const lines: string[] = [];
    const taking = takeSlot({ dir: tmp, n: 1, label: 'BL-138', first: false, pollMs: 10, onWait: (_, line) => lines.push(line) });
    await new Promise((r) => setTimeout(r, 50));
    expect(lines).toEqual(['Waiting for 1 other test run (BL-120)…']);
    fs.rmSync(path.join(tmp, 'other.json'));
    const release = await taking;
    const mine = readQueue(tmp);
    expect(mine).toMatchObject([{ pid: process.pid, label: 'BL-138', running: true }]);
    release();
    expect(readQueue(tmp)).toEqual([]);
  });
});

describe('writeChecksConfig', () => {
  it('writes the setting where the test script reads it, only when it changed', async () => {
    expect(await writeChecksConfig(tmp, 3)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'flotilla', 'checks.json'), 'utf8'))).toEqual({ maxParallel: 3 });
    expect(await writeChecksConfig(tmp, 3)).toBe(false);
  });
});
