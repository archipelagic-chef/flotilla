import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkJobLogRef, firstErrorLine, JobLogProvider, parseJobLogUri, showJobLog } from '../../../../src/features/ci/jobLog';

const vs = vi.hoisted(() => ({ openTextDocument: vi.fn(), showTextDocument: vi.fn(), showErrorMessage: vi.fn() }));

vi.mock('vscode', () => ({
  EventEmitter: class {
    event = () => ({ dispose: () => undefined });
    fire() {}
    dispose() {}
  },
  Uri: { from: (o: Record<string, string>) => ({ ...o, toString: () => `${o.scheme}:${o.path}?${o.query}` }) },
  Position: class {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  },
  Selection: class {
    constructor(
      readonly anchor: unknown,
      readonly active: { line: number },
    ) {}
  },
  Range: class {
    constructor(
      readonly start: unknown,
      readonly end: unknown,
    ) {}
  },
  TextEditorRevealType: { AtTop: 2 },
  window: { showTextDocument: vs.showTextDocument, showErrorMessage: vs.showErrorMessage },
  workspace: { openTextDocument: vs.openTextDocument },
}));

beforeEach(() => vi.clearAllMocks());

describe('checkJobLogRef', () => {
  const ref = { owner: 'acme', repo: 'app', jobId: 9, jobName: 'test' };

  it('accepts a repository and a job id', () => {
    expect(checkJobLogRef(ref)).toEqual(ref);
  });

  it('refuses names that could reach other API routes, and ids that aren’t whole numbers', () => {
    expect(() => checkJobLogRef({ ...ref, owner: '../orgs' })).toThrow('Not a GitHub repository');
    expect(() => checkJobLogRef({ ...ref, repo: 'a/b' })).toThrow('Not a GitHub repository');
    expect(() => checkJobLogRef({ ...ref, jobId: '9' })).toThrow('Not a GitHub Actions job id');
    expect(() => checkJobLogRef({ ...ref, jobId: 9.5 })).toThrow('Not a GitHub Actions job id');
    expect(() => checkJobLogRef(undefined)).toThrow();
  });
});

describe('parseJobLogUri', () => {
  it('reads the job from the query, and checks it', () => {
    const query = JSON.stringify({ owner: 'acme', repo: 'app', jobId: 9, jobName: 'test' });
    expect(parseJobLogUri({ query })).toMatchObject({ owner: 'acme', jobId: 9 });
    expect(() => parseJobLogUri({ query: JSON.stringify({ owner: 'acme', repo: 'app', jobId: 'x' }) })).toThrow();
  });
});

describe('firstErrorLine', () => {
  it('finds the first line marked as an error', () => {
    expect(firstErrorLine('ok\n▸ Test\nERROR: boom\nERROR: again')).toBe(2);
  });

  it('finds none', () => {
    expect(firstErrorLine('ok\nfine')).toBe(-1);
  });
});

describe('showJobLog', () => {
  const arg = { owner: 'acme', repo: 'app', jobId: 9, jobName: 'test' };
  const provider = { refresh: vi.fn() } as unknown as JobLogProvider;

  it('opens the job’s log with the cursor on its first error', async () => {
    const doc = { getText: () => 'ok\n▸ Test\nERROR: boom' };
    const editor = { selection: undefined as unknown, revealRange: vi.fn() };
    vs.openTextDocument.mockResolvedValue(doc);
    vs.showTextDocument.mockResolvedValue(editor);
    await showJobLog(arg, provider);
    expect(vs.showTextDocument).toHaveBeenCalledWith(doc, { preview: true });
    expect((editor.selection as { active: { line: number } }).active.line).toBe(2);
    expect(editor.revealRange).toHaveBeenCalled();
  });

  it('puts the cursor on the first line when the log has no error', async () => {
    const editor = { selection: undefined as unknown, revealRange: vi.fn() };
    vs.openTextDocument.mockResolvedValue({ getText: () => 'all fine' });
    vs.showTextDocument.mockResolvedValue(editor);
    await showJobLog(arg, provider);
    expect((editor.selection as { active: { line: number } }).active.line).toBe(0);
  });

  it('refuses a bad argument without opening anything', async () => {
    await showJobLog({ ...arg, jobId: '9' }, provider);
    expect(vs.openTextDocument).not.toHaveBeenCalled();
    expect(vs.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Not a GitHub Actions job id'));
  });

  it('says why a log can’t be read', async () => {
    vs.openTextDocument.mockRejectedValue(new Error('404 Not Found'));
    await showJobLog(arg, provider);
    expect(vs.showErrorMessage).toHaveBeenCalledWith("Can't read the log: 404 Not Found");
  });
});
