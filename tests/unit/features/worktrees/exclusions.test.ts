import { describe, expect, it } from 'vitest';
import { isInWorktreesFolder, missingExclusions } from '../../../../src/features/worktrees/exclusions';

const excluded = {
  watcherExclude: { '.worktrees/**': true },
  searchExclude: { '.worktrees': true },
  scanIgnoredFolders: ['node_modules', '.worktrees'],
};

describe('missingExclusions', () => {
  it('is empty when every exclusion is in effect', () => {
    expect(missingExclusions(excluded)).toEqual([]);
  });

  it('names what still sees the worktrees folder', () => {
    expect(missingExclusions({ ...excluded, scanIgnoredFolders: ['node_modules'] })).toEqual(['the Git repository scan']);
    expect(missingExclusions({ ...excluded, watcherExclude: {} })).toEqual(['file watching']);
    expect(missingExclusions({ ...excluded, searchExclude: {} })).toEqual(['search']);
  });

  it('counts an exclusion the user switched off as missing', () => {
    expect(missingExclusions({ ...excluded, watcherExclude: { '.worktrees/**': false } })).toEqual(['file watching']);
  });

  it('lists every missing one', () => {
    expect(missingExclusions({ watcherExclude: {}, searchExclude: {}, scanIgnoredFolders: [] })).toEqual([
      'file watching',
      'search',
      'the Git repository scan',
    ]);
  });
});

describe('isInWorktreesFolder', () => {
  it("is true for a worktree under the main checkout's .worktrees folder", () => {
    expect(isInWorktreesFolder('/repo', '/repo/.worktrees/feature-x')).toBe(true);
  });

  it('is false for the main checkout, for the folder itself, and for worktrees elsewhere', () => {
    expect(isInWorktreesFolder('/repo', '/repo')).toBe(false);
    expect(isInWorktreesFolder('/repo', '/repo/.worktrees')).toBe(false);
    expect(isInWorktreesFolder('/repo', '/repo/feature-x')).toBe(false);
    expect(isInWorktreesFolder('/repo', '/elsewhere/.worktrees/feature-x')).toBe(false);
  });
});
