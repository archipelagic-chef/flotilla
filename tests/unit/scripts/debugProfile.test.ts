import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  describeDebugProfile,
  fakesArg,
  findClaudeCode,
  installClaudeCode,
  syncDebugProfile,
  writeProfileSettings,
} from '../../../scripts/debug-profile.mjs';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-profile-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** An installed extension folder with a package.json, as VS Code leaves it. */
function installed(folder: string, name: string, body = 'x') {
  const dir = path.join(folder, name);
  fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'resources', 'native'), body);
  return dir;
}

describe('findClaudeCode', () => {
  it("picks the newest version, and this platform's build over a universal one of the same version", () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    for (const name of [
      'anthropic.claude-code-2.1.296-linux-x64',
      'anthropic.claude-code-2.1.296',
      'anthropic.claude-code-2.1.3-linux-x64',
      'anthropic.claude-code-9.0.0-win32-x64',
      'anthropic.claude-code-3.0.0-linux-arm64',
      'archipelagic.flotilla-0.2.0',
    ]) {
      fs.mkdirSync(path.join(a, name), { recursive: true });
    }
    fs.mkdirSync(path.join(b, 'anthropic.claude-code-2.1.296-linux-x64'), { recursive: true });

    const found = findClaudeCode([a, b], 'linux', 'x64');
    expect(found?.name).toBe('anthropic.claude-code-2.1.296-linux-x64');
    expect(found?.path).toBe(path.join(a, 'anthropic.claude-code-2.1.296-linux-x64'));
  });

  it("prefers a universal build to another platform's", () => {
    fs.mkdirSync(path.join(tmp, 'anthropic.claude-code-1.0.0-win32-x64'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'anthropic.claude-code-1.0.0'), { recursive: true });
    expect(findClaudeCode([tmp], 'linux', 'x64')?.name).toBe('anthropic.claude-code-1.0.0');
  });

  it("is undefined when Claude Code isn't installed, and skips folders that do not exist", () => {
    fs.mkdirSync(path.join(tmp, 'archipelagic.flotilla-0.2.0'));
    expect(findClaudeCode([tmp, path.join(tmp, 'missing')], 'linux', 'x64')).toBeUndefined();
  });
});

describe('installClaudeCode', () => {
  it('copies the folder, replaces an older copy, and leaves other extensions alone', () => {
    const source = installed(path.join(tmp, 'home'), 'anthropic.claude-code-2.1.296-linux-x64', 'new');
    const extensions = path.join(tmp, 'debug-extensions');
    installed(extensions, 'anthropic.claude-code-2.1.100-linux-x64', 'old');
    installed(extensions, 'archipelagic.flotilla-0.2.0');

    expect(installClaudeCode(source, extensions)).toBe('anthropic.claude-code-2.1.296-linux-x64');
    expect(fs.readFileSync(path.join(extensions, 'anthropic.claude-code-2.1.296-linux-x64', 'resources', 'native'), 'utf8')).toBe('new');
    expect(fs.existsSync(path.join(extensions, 'anthropic.claude-code-2.1.100-linux-x64'))).toBe(false);
    expect(fs.existsSync(path.join(extensions, 'archipelagic.flotilla-0.2.0', 'package.json'))).toBe(true);
    expect(fs.readdirSync(extensions).some((name) => name.endsWith('.partial'))).toBe(false);
  });

  it('keeps a finished copy as it is, and removes every Claude Code copy when none is installed', () => {
    const source = installed(path.join(tmp, 'home'), 'anthropic.claude-code-2.1.296-linux-x64');
    const extensions = path.join(tmp, 'debug-extensions');
    installClaudeCode(source, extensions);
    fs.writeFileSync(path.join(extensions, 'anthropic.claude-code-2.1.296-linux-x64', 'marker'), '');

    installClaudeCode(source, extensions);
    expect(fs.existsSync(path.join(extensions, 'anthropic.claude-code-2.1.296-linux-x64', 'marker'))).toBe(true);

    expect(installClaudeCode(undefined, extensions)).toBeUndefined();
    expect(fs.readdirSync(extensions)).toEqual([]);
  });
});

describe('writeProfileSettings', () => {
  const profile = () => path.join(tmp, 'profile');
  const settingsOf = () => JSON.parse(fs.readFileSync(path.join(profile(), 'User', 'settings.json'), 'utf8'));

  it('points Flotilla at the fakes that exist, when they are on', () => {
    fs.mkdirSync(path.join(tmp, 'scripts'));
    fs.writeFileSync(path.join(tmp, 'scripts', 'fake-claude.mjs'), '');
    const result = writeProfileSettings(profile(), { root: tmp, fakes: true });

    expect(result).toEqual({ on: true, applied: ['fake Claude'], unreadable: false });
    expect(settingsOf()).toEqual({ 'flotilla.agents.claudePath': path.join(tmp, 'scripts', 'fake-claude.mjs') });
  });

  it('takes the fakes out when they are off, and keeps the settings it does not manage', () => {
    fs.mkdirSync(path.join(profile(), 'User'), { recursive: true });
    fs.writeFileSync(
      path.join(profile(), 'User', 'settings.json'),
      JSON.stringify({ 'editor.fontSize': 13, 'flotilla.agents.claudePath': '/fake', 'flotilla.dev.githubApi': 'http://x' }),
    );
    expect(writeProfileSettings(profile(), { root: tmp, fakes: false })).toEqual({ on: false, applied: [], unreadable: false });
    expect(settingsOf()).toEqual({ 'editor.fontSize': 13 });
  });

  it('keeps the last choice when no flag is given', () => {
    fs.mkdirSync(path.join(tmp, 'scripts'));
    fs.writeFileSync(path.join(tmp, 'scripts', 'fake-github.mjs'), '');
    writeProfileSettings(profile(), { root: tmp, fakes: true });
    expect(writeProfileSettings(profile(), { root: tmp, fakes: undefined }).on).toBe(true);
    expect(settingsOf()).toEqual({ 'flotilla.dev.githubApi': 'http://127.0.0.1:4010' });

    writeProfileSettings(profile(), { root: tmp, fakes: false });
    expect(writeProfileSettings(profile(), { root: tmp, fakes: undefined }).on).toBe(false);
  });

  it('leaves a settings file that is not plain JSON as it is, and says so', () => {
    fs.mkdirSync(path.join(profile(), 'User'), { recursive: true });
    const file = path.join(profile(), 'User', 'settings.json');
    fs.writeFileSync(file, '{ // a comment\n"editor.fontSize": 13,\n}\n');
    expect(writeProfileSettings(profile(), { root: tmp, fakes: true })).toEqual({ on: false, applied: [], unreadable: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('{ // a comment\n"editor.fontSize": 13,\n}\n');
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });
});

describe('syncDebugProfile', () => {
  it('makes the profile and the debug extensions under the project, and nothing outside it', () => {
    const home = path.join(tmp, 'home');
    installed(path.join(home, '.vscode-server', 'extensions'), 'anthropic.claude-code-2.1.296-linux-x64');
    const project = path.join(tmp, 'project');
    fs.mkdirSync(project);

    const result = syncDebugProfile({
      root: project,
      fakes: undefined,
      folders: [path.join(home, '.vscode-server', 'extensions')],
      platform: 'linux',
      arch: 'x64',
    });

    expect(result).toMatchObject({ claudeCode: 'anthropic.claude-code-2.1.296-linux-x64', on: false, applied: [] });
    expect(fs.existsSync(path.join(project, '.vscode-test', 'debug-extensions', 'anthropic.claude-code-2.1.296-linux-x64', 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(project, '.vscode-test', 'debug-profile', 'User', 'settings.json'))).toBe(true);
    expect(fs.readdirSync(home)).toEqual(['.vscode-server']);
  });

  it('reads --fakes and --no-fakes from the command line', () => {
    expect(fakesArg(['--fakes'])).toBe(true);
    expect(fakesArg(['--no-fakes'])).toBe(false);
    expect(fakesArg([])).toBeUndefined();
  });

  it('says what it did, in a few lines', () => {
    const text = describeDebugProfile({
      profile: '.vscode-test/debug-profile',
      extensions: '.vscode-test/debug-extensions',
      claudeCode: undefined,
      on: true,
      applied: [],
    });
    expect(text).toContain('no Claude Code found');
    expect(text).toContain('fakes on (no fake files in scripts/ yet');
  });
});
