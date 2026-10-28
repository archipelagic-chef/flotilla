import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { BacklogItem } from '../../../src/features/backlog/backlog';
import { reviewerPrompt } from '../../../src/features/backlog/review';

// The prompt's module loads vscode; nothing of it is used here.
function stub(): any {
  const fn = function () {};
  return new Proxy(fn, {
    get: (_t, key) => (key === 'then' ? undefined : key === Symbol.toPrimitive ? () => '' : stub()),
    apply: () => stub(),
    construct: () => stub(),
  });
}
vi.mock('vscode', () => new Proxy({}, { has: () => true, get: (_t, key) => (key === 'Uri' ? class {} : stub()[key as string]) }));
const { agentPrompt } = await import('../../../src/ui/commands');

const at = '2026-10-28T10:00:00Z';
const it_ = (id: string, title: string, status: BacklogItem['status'], more: Partial<BacklogItem> = {}): BacklogItem => ({
  id,
  title,
  status,
  created: at,
  ...more,
});
const items = [
  it_('BL-171', 'Compact cards', 'doing'),
  it_('BL-172', 'Cards fold', 'done', { parent: 'BL-171' }),
  it_('BL-173', 'Cards show the merge', 'doing', { parent: 'BL-171' }),
  it_('BL-174', 'Cards in a grid', 'todo', { parent: 'BL-171', discarded: { at } }),
  it_('BL-9', 'Unrelated', 'todo'),
];
const ticket = '/b/BL-173.md';
const work = (item: BacklogItem) => agentPrompt(item, ticket, 'feature/BL-173', 'Ada-1', '/b/AGENTS.md', undefined, items);
const review = (item: BacklogItem) =>
  reviewerPrompt({ item, reviewer: 'Vega-2', implementer: 'Ada-1', ticket, branch: 'feature/BL-173', base: 'main', round: 1, items });

describe('the prompts of a ticket of an epic (BL-237)', () => {
  it("lists the epic and the sisters in the implementer's prompt, one line each, and asks before building what's done", () => {
    const prompt = work(items[2]);
    expect(prompt).toContain(
      'It\'s part of the epic BL-171 "Compact cards" (its ticket /b/BL-171.md), with these other tickets:\n- BL-172 "Cards fold": Done, /b/BL-172.md\n- BL-174 "Cards in a grid": discarded (won\'t do), /b/BL-174.md',
    );
    expect(prompt).not.toContain('BL-9');
    expect(prompt).not.toContain('- BL-173');
    expect(prompt).toContain("read the epic's ticket and the last reports of its Done tickets");
    expect(prompt).toMatch(
      /build nothing of that part: ask in your report instead \("Needs from you:", with questions\), saying which ticket covers or contradicts it/,
    );
  });

  it("lists them in the reviewer's prompt, and makes going against them a reason to request changes", () => {
    const prompt = review(items[2]);
    expect(prompt).toContain('- BL-172 "Cards fold": Done, /b/BL-172.md');
    expect(prompt).toContain('- BL-174 "Cards in a grid": discarded (won\'t do)');
    expect(prompt).toContain("goes against the epic or a sister's work, is a reason to request changes");
  });

  it('leaves the prompts of a ticket without a parent as they were', () => {
    const plain = items[4];
    expect(work(plain)).toBe(agentPrompt(plain, ticket, 'feature/BL-173', 'Ada-1', '/b/AGENTS.md'));
    expect(work(plain)).not.toContain('epic');
    expect(review(plain)).toBe(
      reviewerPrompt({ item: plain, reviewer: 'Vega-2', implementer: 'Ada-1', ticket, branch: 'feature/BL-173', base: 'main', round: 1 }),
    );
    expect(review(plain)).not.toContain('part of the epic');
  });
});
