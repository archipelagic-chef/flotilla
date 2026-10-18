import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  extensions: { getExtension: () => undefined },
}));

import { agentOutcome, agentStart, headlessArgs, resultOf, setAgentDirs } from '../../../src/ui/backlog/agentRunner';

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

  it('starts lean: no skills, plugins or MCP servers, and the coding tools last', () => {
    const lean = { flags: ['--disable-slash-commands', '--strict-mcp-config', '--settings', '/tmp/lean.json'], tools: ['Bash', 'Read', 'Agent'] };
    const args = headlessArgs({ prompt: 'Hi', name: 'n', sessionId: SESSION, mode: 'auto', lean });
    for (const flag of lean.flags) expect(args).toContain(flag);
    expect(args.slice(-2)).toEqual(['--tools', 'Bash,Read,Agent']);
  });

  it('keeps a run’s own tool list over the lean start’s', () => {
    const lean = { flags: ['--disable-slash-commands'], tools: ['Bash', 'Read'] };
    const args = headlessArgs({ prompt: 'Hi', name: 'n', sessionId: SESSION, mode: 'dontAsk', tools: ['Read', 'Grep'], lean });
    expect(args).toContain('--disable-slash-commands');
    expect(args.slice(-5)).toEqual(['--tools', 'Read,Grep', '--allowedTools', 'Read', 'Grep']);
  });

  it('lets every agent reach the backlog folder (its ticket), whatever lists follow (BL-89)', () => {
    setAgentDirs(['/repo/.flotilla/backlog']);
    try {
      const start = agentStart('/repo/.worktrees/feature-x');
      expect(start?.flags.slice(-2)).toEqual(['--add-dir', '/repo/.flotilla/backlog']);
      // A lean start's tools come last; with a run's own tools, so do they: --add-dir's folders end at the next flag.
      for (const tools of [undefined, ['Read']]) {
        const args = headlessArgs({ prompt: 'Hi', name: 'n', sessionId: SESSION, mode: 'auto', lean: start, tools });
        const at = args.indexOf('--add-dir');
        expect(args[at + 1]).toBe('/repo/.flotilla/backlog');
        expect(args[at + 2]).toMatch(/^--/);
      }
    } finally {
      setAgentDirs([]);
    }
  });

  it('offers every built-in tool when it lists none', () => {
    const args = headlessArgs({ prompt: 'Hi', name: 'n', sessionId: SESSION, mode: 'auto' });
    expect(args).not.toContain('--tools');
    expect(args).not.toContain('--allowedTools');
  });
});

describe('an agent result', () => {
  it('is its last message, whole (a reply can be longer than a note)', () => {
    const reply = 'Line.\n'.repeat(1000);
    expect(resultOf(JSON.stringify({ type: 'result', is_error: false, result: reply }))).toBe(reply);
  });

  it('is nothing when the output is not a result', () => {
    expect(resultOf('not json')).toBeUndefined();
    expect(resultOf(JSON.stringify({ type: 'result', result: 3 }))).toBeUndefined();
  });
});

describe('an agent outcome', () => {
  const now = new Date('2026-10-13T07:00:00');
  const result = (text: string) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text });

  it('is its reply when it exits 0 with a result', () => {
    expect(agentOutcome({ code: 0, stdout: result('Tags too.'), stderr: '', now })).toEqual({ code: 0, reply: 'Tags too.' });
  });

  it('is an error when it exits 0 but its result is an error (no reply)', () => {
    const stdout = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 500' });
    const outcome = agentOutcome({ code: 0, stdout, stderr: '', now });
    expect(outcome.reply).toBeUndefined();
    expect(outcome.error).toBe('API Error: 500');
    expect(outcome.limit).toBeUndefined();
  });

  it('is an error with the stderr when it exits non-zero', () => {
    expect(agentOutcome({ code: 1, stdout: '', stderr: 'boom', now })).toEqual({ code: 1, error: 'boom' });
  });

  it('is a usage limit when it hit one, with no reply', () => {
    const stdout = JSON.stringify({ type: 'result', is_error: true, result: 'Claude AI usage limit reached|1760000000' });
    const outcome = agentOutcome({ code: 0, stdout, stderr: '', now });
    expect(outcome.reply).toBeUndefined();
    expect(outcome.limit).toMatchObject({ known: true, kind: 'usage' });
  });
});
