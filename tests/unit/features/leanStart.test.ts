import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enabledPlugins, leanFlags, writeLeanSettings } from '../../../src/features/backlog/leanStart';
import { makeTempDir, removeDir, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

describe('enabledPlugins', () => {
  it('takes the plugins enabled, later settings overriding earlier ones', () => {
    const user = JSON.stringify({ enabledPlugins: { 'superpowers@official': true, 'frontend-design@official': true, 'old@x': false } });
    const project = JSON.stringify({ enabledPlugins: { 'frontend-design@official': false, 'team@corp': true } });
    expect(enabledPlugins([user, project, undefined, '{ not json'])).toEqual(['superpowers@official', 'team@corp']);
  });
});

describe('leanFlags', () => {
  it('turns off skills and MCP servers, and plugins when there is a settings file', () => {
    expect(leanFlags(undefined)).toEqual(['--disable-slash-commands', '--strict-mcp-config']);
    expect(leanFlags('/tmp/lean.json')).toEqual(['--disable-slash-commands', '--strict-mcp-config', '--settings', '/tmp/lean.json']);
  });
});

describe('writeLeanSettings', () => {
  it('writes a settings file that switches off every enabled plugin, once', () => {
    const config = makeTempDir();
    const cwd = makeTempDir();
    const out = makeTempDir();
    cleanup.push(config, cwd, out);
    writeFile(config, 'settings.json', JSON.stringify({ enabledPlugins: { 'superpowers@official': true } }));
    writeFile(cwd, '.claude/settings.local.json', JSON.stringify({ enabledPlugins: { 'local@x': true } }));

    const file = writeLeanSettings({ cwd, configDir: config, outDir: out })!;
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ enabledPlugins: { 'local@x': false, 'superpowers@official': false } });
    expect(writeLeanSettings({ cwd, configDir: config, outDir: out })).toBe(file);
    expect(fs.readdirSync(out)).toEqual([path.basename(file)]);
  });

  it('writes nothing when no plugin is enabled', () => {
    const config = makeTempDir();
    const out = makeTempDir();
    cleanup.push(config, out);
    expect(writeLeanSettings({ cwd: config, configDir: config, outDir: out })).toBeUndefined();
    expect(fs.readdirSync(out)).toEqual([]);
  });
});
