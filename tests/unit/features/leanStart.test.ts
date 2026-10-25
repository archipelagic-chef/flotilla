import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  agentSettingsText,
  enabledPlugins,
  leanFlags,
  writeAgentSettings,
} from '../../../src/features/backlog/leanStart';
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

describe('writeAgentSettings', () => {
  it('writes a settings file that switches off every enabled plugin, once', () => {
    const config = makeTempDir();
    const cwd = makeTempDir();
    const out = makeTempDir();
    cleanup.push(config, cwd, out);
    writeFile(config, 'settings.json', JSON.stringify({ enabledPlugins: { 'superpowers@official': true } }));
    writeFile(cwd, '.claude/settings.local.json', JSON.stringify({ enabledPlugins: { 'local@x': true } }));

    const file = writeAgentSettings({ cwd, configDir: config, outDir: out, lean: true })!;
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ enabledPlugins: { 'local@x': false, 'superpowers@official': false } });
    expect(writeAgentSettings({ cwd, configDir: config, outDir: out, lean: true })).toBe(file);
    expect(fs.readdirSync(out)).toEqual([path.basename(file)]);
  });

  it('writes nothing when no plugin is enabled', () => {
    const config = makeTempDir();
    const out = makeTempDir();
    cleanup.push(config, out);
    expect(writeAgentSettings({ cwd: config, configDir: config, outDir: out, lean: true })).toBeUndefined();
    expect(fs.readdirSync(out)).toEqual([]);
  });
});

describe('agentSettingsText', () => {
  it('sets the compaction window, the subagent model and the guard hook, with or without a lean start', () => {
    expect(JSON.parse(agentSettingsText(['p@x'], { autoCompactWindow: 200000, subagentModel: 'sonnet', guardCommand: 'node "/tmp/g.js"' })!)).toEqual({
      autoCompactWindow: 200000,
      env: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' },
      hooks: { PreToolUse: [{ matcher: 'Read|Bash', hooks: [{ type: 'command', command: 'node "/tmp/g.js"', timeout: 15 }] }] },
    });
    expect(JSON.parse(agentSettingsText(['p@x'], { lean: true })!)).toEqual({ enabledPlugins: { 'p@x': false } });
    expect(agentSettingsText([], { lean: true })).toBeUndefined();
  });
});
