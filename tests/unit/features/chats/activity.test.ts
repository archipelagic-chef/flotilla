import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  parseTranscript,
  readTranscript,
  transcriptPath,
} from '../../../../src/features/chats/chats';
import {
  type AgentActivity,
  DEFAULT_STUCK_RULES,
  health,
  nowLine,
  progress,
  statusLine,
  toolPhrase,
} from '../../../../src/features/chats/activity';
import {
  makeTempDir,
  removeDir,
} from '../../../helpers/gitRepo';

const T0 = '2026-10-24T10:00:00.000Z';
const at = (min: number, sec = 0) => new Date(Date.parse(T0) + min * 60_000 + sec * 1000).toISOString();
const reply = (content: unknown[], timestamp = T0, extra: object = {}) =>
  JSON.stringify({ type: 'assistant', timestamp, cwd: '/w', message: { id: `m${Math.random()}`, model: 'claude-opus-5-5', content }, ...extra });
const tool = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input });
const result = (id: string, error = false) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error }] } });
const activityOf = (lines: string[]) => parseTranscript('s', lines.join('\n'), new Date()).activity;

describe('reading what an agent is doing from its transcript', () => {
  it('gives the tool call running, with its main argument and since when', () => {
    const a = activityOf([reply([{ type: 'text', text: 'Now the tests.\nThen the build.' }, tool('t1', 'Bash', { command: 'npm test' })], at(0))]);
    expect(a).toMatchObject({ tool: { id: 't1', name: 'Bash', detail: 'npm test', since: at(0) }, thoughts: ['Now the tests.'] });
    expect(a!.tool!.done).toBeUndefined();
    expect(nowLine(a!, Date.parse(at(2, 10)))).toEqual({ text: 'Running `npm test` · 2:10', running: true });
  });

  it('marks the call done when its result comes, failed when it is an error', () => {
    const lines = [reply([tool('t1', 'Edit', { file_path: '/w/src/a.ts' })]), result('t1')];
    expect(activityOf(lines)!.tool).toMatchObject({ detail: 'src/a.ts', done: true });
    expect(nowLine(activityOf(lines)!)?.text).toBe('Last: Editing src/a.ts');
    expect(activityOf([reply([tool('t1', 'Read', { file_path: '/x' })]), result('t1', true)])!.tool!.failed).toBe(true);
  });

  it('keeps the latest todo list and its progress', () => {
    const todos = (done: number) =>
      tool(`w${done}`, 'TodoWrite', {
        todos: ['Read', 'Build', 'Test'].map((t, n) => ({
          content: t,
          activeForm: `${t}ing`,
          status: n < done ? 'completed' : n === done ? 'in_progress' : 'pending',
        })),
      });
    const a = activityOf([reply([todos(0)]), result('w0'), reply([todos(2)])]);
    expect(a!.todos).toHaveLength(3);
    expect(progress(a!)).toEqual({ done: 2, total: 3, current: 'Testing' });
    expect(statusLine({ ...a!, tool: { ...a!.tool!, done: true } })).toBe('Last: Updating its plan · 2 of 3');
  });

  it('keeps the last three thoughts, newest last, and skips subagents', () => {
    const say = (text: string, extra = {}) => reply([{ type: 'text', text }], T0, extra);
    const a = activityOf([say('one'), say('two'), say('three'), say('four'), say('a subagent', { isSidechain: true })]);
    expect(a!.thoughts).toEqual(['two', 'three', 'four']);
  });

  it('counts the same command failing in a row', () => {
    const run = (n: number) => [reply([tool(`b${n}`, 'Bash', { command: 'npm run build' })]), result(`b${n}`, true)];
    const a = activityOf([...run(1), ...run(2), ...run(3), ...run(4)]);
    expect(a!.failing).toEqual({ command: 'npm run build', times: 4 });
    expect(health(a, at(0), DEFAULT_STUCK_RULES, true, Date.parse(at(0, 20)))).toEqual({ text: 'Same command failed 4 times: `npm run build`', stuck: true });
  });
});

describe('reading only the new part', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach(removeDir));

  it('follows a call from running to done as the transcript grows', async () => {
    const home = makeTempDir();
    dirs.push(home);
    const sid = '1d3f2c1e-5a4b-4c3d-9e8f-0a1b2c3d4e5f';
    const file = transcriptPath('/w', sid, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${reply([tool('t1', 'Bash', { command: 'npm test' })])}\n`);
    expect((await readTranscript('/w', sid, home))?.activity?.tool?.done).toBeUndefined();
    fs.appendFileSync(file, `${result('t1')}\n`);
    expect((await readTranscript('/w', sid, home))?.activity?.tool?.done).toBe(true);
  });
});

describe("an agent's health", () => {
  const running: AgentActivity = { tool: { id: 't', name: 'Bash', detail: 'npm test', since: at(0) } };

  it('is active, with when it last wrote', () => {
    expect(health(undefined, at(0), DEFAULT_STUCK_RULES, true, Date.parse(at(0, 20)))).toEqual({ text: 'active 20 s ago', stuck: false });
  });

  it('warns of a long silence while its process runs, not while it waits for you', () => {
    const done: AgentActivity = { tool: { ...running.tool!, done: true } };
    expect(health(done, at(0), DEFAULT_STUCK_RULES, true, Date.parse(at(14)))).toEqual({ text: 'No activity for 14 min', stuck: true });
    expect(health(done, at(0), DEFAULT_STUCK_RULES, false, Date.parse(at(14))).stuck).toBe(false);
  });

  it('warns of a command running too long (and not of the silence it makes)', () => {
    expect(health(running, at(0), DEFAULT_STUCK_RULES, true, Date.parse(at(12))).stuck).toBe(false);
    expect(health(running, at(0), DEFAULT_STUCK_RULES, true, Date.parse(at(18)))).toEqual({ text: '`npm test` running for 18 min', stuck: true });
  });

  it('takes its thresholds from the rules; 0 switches one off', () => {
    const rules = { ...DEFAULT_STUCK_RULES, commandMinutes: 0, silentMinutes: 5 };
    expect(health(running, at(0), rules, true, Date.parse(at(18))).stuck).toBe(false);
    expect(health(undefined, at(0), rules, true, Date.parse(at(6))).text).toBe('No activity for 6 min');
  });
});

describe('what a tool call reads as', () => {
  it('names the command, the file, or the ticket', () => {
    expect(toolPhrase({ name: 'Read', detail: '/repo/.flotilla/backlog/BL-175.md' })).toBe('Reading the ticket');
    expect(toolPhrase({ name: 'Grep', detail: 'TodoWrite' })).toBe('Searching for `TodoWrite`');
    expect(toolPhrase({ name: 'mcp__github__get_issue' })).toBe('Using github get_issue');
  });
});
