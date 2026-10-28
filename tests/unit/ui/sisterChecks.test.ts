import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { BacklogData, BacklogItem } from '../../../src/features/backlog/backlog';
import { needOf } from '../../../src/features/backlog/needs';
import {
  checkingOf,
  noteChange,
  SISTER_DEBOUNCE_MS,
  SISTER_STALE_MS,
} from '../../../src/features/backlog/sisterCheck';
import type { Ticket, TicketEntry } from '../../../src/features/backlog/ticket';

vi.mock('vscode', () => ({}));
vi.mock('../../../src/ui/progress', () => ({ trackProgress: () => undefined }));
vi.mock('../../../src/ui/backlog/agentRunner', () => ({ agentChoice: () => ({}), runAgentHeadless: () => undefined }));

import { SisterChecks } from '../../../src/ui/backlog/sisterChecks';

type Result = { code: number | null; error?: string; reply?: string };

const item = (id: string, over: Partial<BacklogItem> = {}): BacklogItem => ({ id, title: `Title ${id}`, status: 'todo', created: '', ...over });

/** A backlog and its tickets in memory: what SisterChecks reads and writes. */
function fake(items: BacklogItem[], descriptions: Record<string, string> = {}) {
  let data = { version: 1, next: 9, items } as unknown as BacklogData;
  const tickets = new Map<string, Ticket>(items.map((i) => [i.id, { title: i.title, description: descriptions[i.id] ?? '', activity: [] as TicketEntry[] }]));
  const runs: Array<{ prompt: string; tools?: string[]; resolve: (r: Result) => void }> = [];
  let now = new Date('2026-10-28T12:00:00Z');
  const backlog = {
    read: async () => structuredClone(data),
    change: async (fn: (d: BacklogData) => BacklogData) => {
      data = fn(structuredClone(data));
      return data;
    },
    watch: () => ({ dispose: () => undefined }),
    ensureDocument: async (i: BacklogItem) => `/t/${i.id}.md`,
    readTicket: async (i: BacklogItem) => structuredClone(tickets.get(i.id)!),
    readTicketCached: async (i: BacklogItem) => structuredClone(tickets.get(i.id)!),
    editTicket: async (i: BacklogItem, fn: (t: Ticket) => Ticket) => void tickets.set(i.id, fn(tickets.get(i.id)!)),
    appendActivity: async (i: BacklogItem, e: TicketEntry) => void tickets.get(i.id)!.activity.push(e),
  };
  const checks = new SisterChecks({
    backlog: backlog as never,
    mainRoot: '/repo',
    base: async () => 'main',
    output: { appendLine: () => undefined } as never,
    isLeader: () => true,
    takenNames: () => [],
    now: () => now,
    run: ((o: { prompt: string; tools?: string[] }) => {
      let resolve!: (r: Result) => void;
      const done = new Promise<Result>((r) => (resolve = r));
      runs.push({ ...o, resolve });
      return { sessionId: `s${runs.length}`, done, stop: () => undefined };
    }) as never,
  });
  return {
    get data() {
      return data;
    },
    tickets,
    runs,
    checks,
    at: (t: number) => (now = new Date(t)),
    async note(id: string, reason: 'merged' | 'described' = 'merged') {
      data = noteChange(data, id, reason, new Map(Object.entries(descriptions)), now);
    },
    async tick() {
      checks.tick();
      for (let n = 0; n < 20; n++) await new Promise((r) => setTimeout(r, 0));
    },
  };
}

const epic = () => [
  item('BL-1'),
  item('BL-2', { parent: 'BL-1', status: 'done' }),
  item('BL-3', { parent: 'BL-1' }),
  item('BL-4', { parent: 'BL-1', status: 'doing' }),
  item('BL-5', { parent: 'BL-1' }),
];

describe('SisterChecks', () => {
  it('starts a check once it is due, with the sisters it may edit', async () => {
    const f = fake(epic());
    await f.note('BL-2');
    const t0 = Date.parse('2026-10-28T12:00:00Z');
    await f.tick();
    expect(f.runs).toHaveLength(0);
    f.at(t0 + SISTER_DEBOUNCE_MS);
    await f.tick();
    expect(f.runs).toHaveLength(1);
    expect(f.runs[0].tools).toEqual(['Read', 'Grep', 'Glob', 'Edit(//t/BL-3.md)', 'Edit(//t/BL-5.md)']);
    expect(f.runs[0].prompt).toContain('BL-2 was merged to main');
    expect(f.data.items[1].sisterCheck?.session).toBe('s1');
    expect(checkingOf(f.data, 'BL-3')).toBe('BL-2');
    f.checks.dispose();
  });

  it('writes its findings into the tickets, asks about a covered one, and releases them', async () => {
    const f = fake(epic());
    await f.note('BL-2');
    f.at(Date.parse('2026-10-28T12:00:00Z') + SISTER_DEBOUNCE_MS);
    await f.tick();
    f.tickets.get('BL-3')!.title = 'Renamed by the agent';
    f.runs[0].resolve({
      code: 0,
      reply:
        'Checked them against main.\n\n## BL-3 · updated\nTook out the button: BL-2 built it.\n## BL-4 · outdated\nIts panel moved.\n## BL-5 · covered\nAll of it is on main.',
    });
    await f.tick();
    expect(f.tickets.get('BL-3')!.title).toBe('Title BL-3');
    expect(f.tickets.get('BL-3')!.activity[0]).toMatchObject({
      author: expect.stringMatching(/^Agent /),
      body: expect.stringContaining('Took out the button'),
    });
    expect(f.tickets.get('BL-4')!.activity[0].body).toContain('Its panel moved.');
    const covered = f.data.items.find((i) => i.id === 'BL-5')!;
    expect(covered.sisterVerdict).toMatchObject({ from: 'BL-2', kind: 'covered', line: 'Covered by BL-2: All of it is on main.' });
    expect(needOf(covered, [])).toMatchObject({ kind: 'sister', line: 'Covered by BL-2: All of it is on main.' });
    expect(f.tickets.get('BL-2')!.activity[0].body).toBe('Checked them against main.\n\n- BL-3: updated\n- BL-4: outdated\n- BL-5: covered');
    expect(checkingOf(f.data, 'BL-3')).toBeUndefined();
    f.checks.dispose();
  });

  it('writes one short entry in the changed ticket when nothing changes', async () => {
    const f = fake(epic());
    await f.note('BL-2');
    f.at(Date.parse('2026-10-28T12:00:00Z') + SISTER_DEBOUNCE_MS);
    await f.tick();
    f.runs[0].resolve({ code: 0, reply: 'All still right.\n## BL-3 · unchanged\n## BL-5 · unchanged' });
    await f.tick();
    expect(['BL-3', 'BL-4', 'BL-5'].map((id) => f.tickets.get(id)!.activity.length)).toEqual([0, 0, 0]);
    expect(f.tickets.get('BL-2')!.activity[0].body).toContain('nothing to change');
    f.checks.dispose();
  });

  it('checks again for a merge that came while it ran, once it ends', async () => {
    const f = fake(epic());
    const t0 = Date.parse('2026-10-28T12:00:00Z') + SISTER_DEBOUNCE_MS;
    await f.note('BL-2', 'described');
    f.at(t0);
    await f.tick();
    await f.note('BL-2', 'merged');
    f.runs[0].resolve({ code: 0, reply: 'All still right.\n## BL-3 · unchanged' });
    await f.tick();
    expect(f.data.items[1].sisterCheck).toMatchObject({ reasons: ['merged'], covers: ['BL-3', 'BL-4', 'BL-5'] });
    expect(f.data.items[1].sisterCheck?.session).toBeUndefined();
    expect(checkingOf(f.data, 'BL-3')).toBe('BL-2');
    f.at(t0 + SISTER_DEBOUNCE_MS);
    await f.tick();
    expect(f.runs).toHaveLength(2);
    expect(f.runs[1].prompt).toContain('BL-2 was merged to main');
    f.checks.dispose();
  });

  it('releases the sisters when it fails, or a window left it', async () => {
    const f = fake(epic());
    await f.note('BL-2');
    const t0 = Date.parse('2026-10-28T12:00:00Z') + SISTER_DEBOUNCE_MS;
    f.at(t0);
    await f.tick();
    f.runs[0].resolve({ code: 1, error: 'boom' });
    await f.tick();
    expect(checkingOf(f.data, 'BL-3')).toBeUndefined();
    expect(f.tickets.get('BL-2')!.activity[0].body).toMatch(/stopped \(boom\): BL-3, BL-4, BL-5 are released, unchecked\./);

    const g = fake(epic());
    await g.note('BL-2');
    g.data.items[1].sisterCheck = { ...g.data.items[1].sisterCheck!, session: 'gone', started: new Date(t0).toISOString() };
    g.at(t0 + SISTER_STALE_MS);
    await g.tick();
    expect(g.runs).toHaveLength(0);
    expect(checkingOf(g.data, 'BL-3')).toBeUndefined();
    expect(g.tickets.get('BL-2')!.activity[0].body).toContain("didn't finish");
    f.checks.dispose();
    g.checks.dispose();
  });
});
