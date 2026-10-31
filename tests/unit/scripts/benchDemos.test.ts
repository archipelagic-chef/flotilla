import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  demoRuns,
  failureKind,
  quantile,
  sessionRuns,
} from '../../../scripts/bench-demos.mjs';

describe('demoRuns', () => {
  it('finds the recorder run however the command wraps it', () => {
    expect(demoRuns('timeout 600 npm run demo -- record x --out a.gif 2>&1 | tail -3')).toEqual([{ mode: 'record', name: 'x' }]);
    expect(demoRuns('cd /w && npm run demo -- check y')).toEqual([{ mode: 'check', name: 'y' }]);
    expect(demoRuns('echo "$(timeout 280 npm run demo -- check z)"')).toEqual([{ mode: 'check', name: 'z' }]);
    expect(demoRuns('PATH=/x:$PATH timeout 500 node scripts/demo.mjs record w')).toEqual([{ mode: 'record', name: 'w' }]);
  });

  it("doesn't count greps of the recorder or its text in a heredoc", () => {
    expect(demoRuns("grep -n 'npm run demo -- record' CONTRIBUTING.md")).toEqual([]);
    expect(demoRuns("cat > r.md <<'EOF'\nnpm run demo -- play x\nEOF\nnpm run demo -- check y")).toEqual([{ mode: 'check', name: 'y' }]);
  });
});

describe('quantile', () => {
  it('is the smallest value that share of them is at or under', () => {
    expect(quantile([0, 0, 0, 1, 2, 3, 4, 5, 9, 14], 0.5)).toBe(2);
    expect(quantile([0, 0, 0, 1, 2, 3, 4, 5, 9, 14], 0.9)).toBe(9);
    expect(quantile([], 0.9)).toBe(0);
  });
});

describe('failureKind', () => {
  it("tells the demo's failures from the recorder's own", () => {
    expect(failureKind({ step: 3, reason: 'nothing visible matches .x after 15000 ms' })).toBe("demo: a step's element not found");
    expect(failureKind({ step: 7, reason: 'keyboard.press: Application exited' })).toBe('recorder: the window closed');
    expect(failureKind({ reason: "Not recorded: the window's title isn't the demo window's (\"\")." })).toBe('recorder: not the demo window');
  });
});

describe('sessionRuns', () => {
  const prompt = { type: 'user', timestamp: '2026-10-25T01:00:00Z', message: { content: 'You are agent Flux-3, working on backlog item BL-1' } };
  const bash = (at: string, command: string) => ({
    type: 'assistant',
    timestamp: at,
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
  });

  it("counts an agent session's runs in the window only", () => {
    const entries = [prompt, bash('2026-10-25T02:00:00Z', 'npm run demo -- record a'), bash('2026-10-26T02:00:00Z', 'npm run demo -- check a')];
    expect(sessionRuns(entries, '2026-10-26', '2026-10-27')).toEqual(['check']);
    expect(sessionRuns(entries, '2026-10-28', '2026-10-29')).toBeUndefined();
  });

  it("leaves out sessions that aren't an agent's", () => {
    expect(sessionRuns([{ ...prompt, message: { content: 'hi' } }], '2026', '2027')).toBeUndefined();
  });
});
