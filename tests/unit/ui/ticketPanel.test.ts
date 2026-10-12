import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));
const { keepShowActivity, showActivityKept } = await import('../../../src/ui/backlog/ticketPanel');

/** A memento as VS Code's global state is: values kept by key, read synchronously. */
function memento(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: <T>(key: string, fallback?: T) => (values.has(key) ? (values.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => void values.set(key, value),
  };
}

describe('the Show activity choice', () => {
  it('is shut until the user opens it', () => {
    expect(showActivityKept(memento() as never)).toBe(false);
  });

  it('is kept for the user once chosen, and shut again when they shut it', async () => {
    const state = memento();
    await keepShowActivity(state as never, true);
    expect(showActivityKept(state as never)).toBe(true);
    await keepShowActivity(state as never, false);
    expect(showActivityKept(state as never)).toBe(false);
  });
});
