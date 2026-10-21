// The VS Code the merge scenarios run in (BL-150): messages are recorded and answered by rule, settings are a map,
// and the checks' terminal really runs their command (FAKE_CHECKS in harness.ts, which exits as the scenario says).

/** What the fake VS Code answers and records. */
export const ui = {
  /** Answers to questions: the first rule whose pattern matches a message answers it, once. */
  rules: [] as Array<{ pattern: RegExp; answer: string }>,
  messages: [] as string[],
  settings: {} as Record<string, unknown>,
  /** The next check runs' results; then 'pass'. */
  checks: [] as Array<'pass' | 'fail' | 'timeout'>,
  /** How many times the checks ran. */
  checkRuns: 0,
};

export function resetUi(settings: Record<string, unknown>): void {
  ui.rules = [];
  ui.messages = [];
  ui.settings = settings;
  ui.checks = [];
  ui.checkRuns = 0;
}

const ask = (message: string) => {
  ui.messages.push(message);
  const rule = ui.rules.findIndex((r) => r.pattern.test(message));
  return Promise.resolve(rule < 0 ? undefined : ui.rules.splice(rule, 1)[0].answer);
};

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  event = (l: (e: T) => void) => (this.listeners.push(l), { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) });
  fire(e: T) {
    [...this.listeners].forEach((l) => l(e));
  }
  dispose() {}
}

export const window = { showInformationMessage: ask, showWarningMessage: ask, showErrorMessage: ask, showQuickPick: async () => undefined };
export const workspace = { getConfiguration: () => ({ get: (k: string, d: unknown) => (k in ui.settings ? ui.settings[k] : d) }) };
export const commands = { executeCommand: async () => undefined };

type Pty = { open(d: unknown): void };
export class Task {
  presentationOptions: unknown;
  constructor(
    readonly definition: { command: string },
    _s: unknown,
    _n: string,
    _src: string,
    readonly execution: { callback: () => Promise<Pty> },
  ) {}
}
export class CustomExecution {
  constructor(readonly callback: () => Promise<Pty>) {}
}
export const TaskScope = { Workspace: 2 };
export const TaskRevealKind = { Always: 1 };
export const TaskPanelKind = { Dedicated: 2 };
export const tasks = {
  executeTask: async (task: Task) => {
    ui.checkRuns++;
    process.env.FLOTILLA_FAKE_CHECKS = ui.checks.shift() ?? 'pass';
    const pty = await task.execution.callback();
    pty.open(undefined);
    return {};
  },
};
