import { describe, expect, it } from 'vitest';
import { branchPickEntries, type BranchPickEntry } from '../../../src/ui/branchPicker';

const branches = { local: ['main', 'feat/a', 'busy'], remote: ['origin/main', 'origin/feat/b', 'origin/busy'] };
const checkedOut = new Map([
  ['main', 'main worktree'],
  ['busy', 'busy'],
]);

const labels = (entries: BranchPickEntry[]) => entries.map((e) => (e.separator ? `--${e.label}--` : e.label));

describe('branchPickEntries', () => {
  it('lists create actions first, then local and remote branches with separators', () => {
    expect(labels(branchPickEntries('', branches, checkedOut))).toEqual([
      '$(plus) Create new branch…',
      '$(plus) Create new branch from…',
      '--Branches--',
      '$(git-branch) main',
      '$(git-branch) feat/a',
      '$(git-branch) busy',
      '--Remote branches--',
      '$(cloud) origin/main',
      '$(cloud) origin/feat/b',
      '$(cloud) origin/busy',
    ]);
  });

  it('keeps the create actions visible while typing and names the branch when the text is a valid new name', () => {
    const entries = branchPickEntries('  fix/login ', branches, checkedOut);
    expect(entries[0]).toMatchObject({ label: "$(plus) Create new branch 'fix/login'", alwaysShow: true, action: { kind: 'createNamed', branch: 'fix/login' } });
    expect(entries[1]).toMatchObject({ alwaysShow: true, action: { kind: 'createFrom' } });
  });

  it('falls back to the prompting create action when the typed text is not a valid new name', () => {
    expect(branchPickEntries('main', branches, checkedOut)[0].action).toEqual({ kind: 'createPrompt' });
    expect(branchPickEntries('a b', branches, checkedOut)[0].action).toEqual({ kind: 'createPrompt' });
  });

  it('marks branches that are checked out in a worktree', () => {
    const busy = branchPickEntries('', branches, checkedOut).find((e) => e.label === '$(git-branch) busy');
    expect(busy).toMatchObject({ description: 'checked out in busy', action: { kind: 'checkedOut', branch: 'busy', where: 'busy' } });
    const free = branchPickEntries('', branches, checkedOut).find((e) => e.label === '$(git-branch) feat/a');
    expect(free?.action).toEqual({ kind: 'existing', branch: 'feat/a' });
  });

  it('maps remote branches to their local branch when one exists', () => {
    const entries = branchPickEntries('', branches, checkedOut);
    const byLabel = (l: string) => entries.find((e) => e.label === l)?.action;
    expect(byLabel('$(cloud) origin/feat/b')).toEqual({ kind: 'remote', remoteRef: 'origin/feat/b' });
    expect(byLabel('$(cloud) origin/busy')).toEqual({ kind: 'checkedOut', branch: 'busy', where: 'busy' });
    expect(byLabel('$(cloud) origin/main')).toEqual({ kind: 'checkedOut', branch: 'main', where: 'main worktree' });
  });

  it('omits empty sections', () => {
    expect(labels(branchPickEntries('', { local: [], remote: [] }, new Map()))).toEqual([
      '$(plus) Create new branch…',
      '$(plus) Create new branch from…',
    ]);
  });
});
