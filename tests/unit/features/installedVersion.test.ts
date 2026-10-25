import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  folderVersion,
  newerInstall,
  newerMessage,
  obsoleteFolders,
  staleStartNote,
} from '../../../src/features/installedVersion';
import { settingsFileOf } from '../../../src/features/backlog/leanStart';

const ID = 'archipelagic.flotilla';
const base = { id: ID, running: '0.1.0', obsolete: new Set<string>(), builtAt: 1, builtNow: 1 };

describe('folderVersion', () => {
  it('reads the version of this extension’s folders only', () => {
    expect(folderVersion('archipelagic.flotilla-0.2.0', ID)).toBe('0.2.0');
    expect(folderVersion('Archipelagic.Flotilla-0.2.0-win32-x64', ID)).toBe('0.2.0');
    expect(folderVersion('archipelagic.flotilla-1.0.0-beta.1', ID)).toBe('1.0.0-beta.1');
    expect(folderVersion('archipelagic.flotilla-extra-0.3.0', ID)).toBeUndefined();
    expect(folderVersion('ms-python.python-2025.1.0', ID)).toBeUndefined();
    expect(folderVersion('.obsolete', ID)).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it('compares by numbers, a pre-release before its release', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0);
  });
});

describe('newerInstall', () => {
  it('finds the highest newer version installed next to the running one', () => {
    const folders = ['archipelagic.flotilla-0.1.0', 'archipelagic.flotilla-0.3.0', 'archipelagic.flotilla-0.2.0', 'other.ext-9.0.0'];
    expect(newerInstall({ ...base, folders })).toEqual({ kind: 'version', version: '0.3.0' });
  });

  it('is undefined when only the running version (or older) is there', () => {
    expect(newerInstall({ ...base, folders: ['archipelagic.flotilla-0.1.0', 'archipelagic.flotilla-0.0.9'] })).toBeUndefined();
  });

  it('skips folders VS Code is removing', () => {
    const folders = ['archipelagic.flotilla-0.1.0', 'archipelagic.flotilla-0.2.0'];
    expect(newerInstall({ ...base, folders, obsolete: new Set(['archipelagic.flotilla-0.2.0']) })).toBeUndefined();
  });

  it('sees the same version installed again by its main file changing', () => {
    expect(newerInstall({ ...base, folders: ['archipelagic.flotilla-0.1.0'], builtNow: 2 })).toEqual({ kind: 'build' });
    expect(newerInstall({ ...base, folders: ['archipelagic.flotilla-0.1.0'], builtNow: undefined })).toBeUndefined();
  });
});

describe('obsoleteFolders', () => {
  it('reads the folders marked true, and nothing from a broken file', () => {
    expect([...obsoleteFolders('{"a-0.1.0":true,"b-0.2.0":false}')]).toEqual(['a-0.1.0']);
    expect(obsoleteFolders('not json').size).toBe(0);
    expect(obsoleteFolders(undefined).size).toBe(0);
  });
});

describe('messages', () => {
  it('says what reloading does to running agents', () => {
    const v = { kind: 'version', version: '0.2.0' } as const;
    expect(newerMessage(v, '0.1.0', 0)).toBe(
      'Flotilla 0.2.0 is installed, but this window still runs 0.1.0: agents start the old way until you reload the window.',
    );
    expect(newerMessage(v, '0.1.0', 1)).toContain('Reloading stops the agent running in this window (its chat is kept to resume).');
    expect(newerMessage(v, '0.1.0', 3)).toContain('Reloading stops the 3 agents running in this window (their chats are kept to resume).');
    expect(newerMessage({ kind: 'build' }, '0.2.0', 0)).toContain('Flotilla 0.2.0 was installed again');
  });

  it('adds a note to the autopilot’s starts', () => {
    expect(staleStartNote({ kind: 'version', version: '0.2.0' }, '0.1.0')).toBe(
      ' (Flotilla 0.2.0 is installed, but this window still runs 0.1.0: the agent starts the old way until you reload the window.)',
    );
  });
});

describe('settingsFileOf', () => {
  it('finds the settings file among the flags', () => {
    expect(settingsFileOf(['--disable-slash-commands', '--settings', 'C:/t/s.json'])).toBe('C:/t/s.json');
    expect(settingsFileOf(['--disable-slash-commands'])).toBeUndefined();
  });
});
