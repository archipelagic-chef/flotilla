import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  extensions: { getExtension: () => undefined },
}));

import { headlessArgs } from '../../../src/ui/backlog/agentRunner';

const SESSION = '3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';

describe('headless agent arguments', () => {
  it('starts a chat with the session it will have, and runs in the given permission mode', () => {
    const args = headlessArgs({ prompt: 'Hi', name: 'Nova-7 · BL-1', sessionId: SESSION, mode: 'auto' });
    expect(args).toEqual(['-p', 'Hi', '--output-format', 'json', '--permission-mode', 'auto', '--name', 'Nova-7 · BL-1', '--session-id', SESSION]);
  });

  it('resumes a chat, with its model and effort', () => {
    const args = headlessArgs({
      prompt: 'Go on',
      name: 'n',
      sessionId: SESSION,
      resume: SESSION,
      mode: 'auto',
      choice: { model: 'opus', effort: 'high' },
    });
    expect(args).toContain('--resume');
    expect(args).not.toContain('--session-id');
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', SESSION]);
    expect(args).toContain('--model');
  });

  it('offers only the tools it lists, with their rules last (no flag follows the lists)', () => {
    const args = headlessArgs({ prompt: 'Hi', name: 'n', sessionId: SESSION, mode: 'dontAsk', tools: ['Read', 'Grep', 'Edit(//a/b.md)'] });
    expect(args.slice(-6)).toEqual(['--tools', 'Read,Grep,Edit', '--allowedTools', 'Read', 'Grep', 'Edit(//a/b.md)']);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
  });

  it('offers every built-in tool when it lists none', () => {
    const args = headlessArgs({ prompt: 'Hi', name: 'n', sessionId: SESSION, mode: 'auto' });
    expect(args).not.toContain('--tools');
    expect(args).not.toContain('--allowedTools');
  });
});
