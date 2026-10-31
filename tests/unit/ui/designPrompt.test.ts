import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { mockupsRule } from '../../../src/features/backlog/design';

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

describe('the implementer’s first prompt', () => {
  it('asks for mockups in the ticket’s folder before a UI change is built (BL-257)', () => {
    const prompt = agentPrompt({ id: 'BL-7', title: 'Expand' }, '/b/BL-7.md', 'feature/BL-7', 'Ada-1', '/b/AGENTS.md');
    expect(prompt).toContain(mockupsRule('BL-7', '/b/BL-7/'));
    expect(prompt).toMatch(/!\[A: Expand in the card's header\]\(BL-7\/mockup-a\.svg\) A \(recommended\)/);
  });
});
