import { describe, expect, it } from 'vitest';
import { missingExclusions } from '../../../../src/features/worktrees/exclusions';

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
    expect(missingExclusions({ watcherExclude: {}, searchExclude: {}, scanIgnoredFolders: [] })).toEqual(['file watching', 'search', 'the Git repository scan']);
  });
});
