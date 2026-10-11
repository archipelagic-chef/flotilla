import { AGENT_NAMES } from '../backlog/backlog';

/**
 * The Claude Code hook. Flotilla installs it as a readable file, `.claude/flotilla-hook.js`, next to each worktree's
 * `.claude/settings.local.json`; the hook command only loads that file (see hookCommand). It reads the hook event
 * from stdin, writes one record per chat into the chat's worktree git dir, and mirrors the record into the git dirs
 * of other worktrees whose files the chat edits. It never fails the agent: every error is swallowed.
 */
const SOURCE = String.raw`
const fs = require('fs'), path = require('path'), cp = require('child_process');
// The chat's agent name (as sessionAgentName in backlog.ts computes it): its ticket reports are signed with it.
const NAMES = ${JSON.stringify(AGENT_NAMES)};
const agentName = (id) => { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return NAMES[h % NAMES.length] + '-' + (1 + (Math.floor(h / NAMES.length) % 9)); };
const STATES = { SessionStart: 'done', UserPromptSubmit: 'working', PostToolUse: 'working', Notification: 'waiting-for-input', Stop: 'done', SessionEnd: 'ended' };
let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (e) {}
// Session ids are UUIDs; anything else is ignored (it would end up in a file name).
const sid = typeof input.session_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.session_id) ? input.session_id : '';
const event = input.hook_event_name;
const state = STATES[event];
if (sid && state) {
  const cwd = input.cwd || process.cwd();
  const gitDir = (dir) => {
    try {
      const out = cp.execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
      return path.resolve(dir, out.trim());
    } catch (e) {
      return undefined;
    }
  };
  const fileFor = (dir) => path.join(dir, 'flotilla', 'chats', sid.replace(/[^A-Za-z0-9._-]/g, '_') + '.json');
  const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return undefined; } };
  const write = (dir, record) => {
    const file = fileFor(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, file);
  };
  const unlinked = (dir) => { const list = read(path.join(dir, 'flotilla', 'unlinked.json')); return Array.isArray(list) && list.includes(sid); };
  const own = gitDir(cwd);
  if (own) {
    const now = new Date().toISOString();
    const record = read(fileFor(own)) || { sessionId: sid, source: 'claude-code', linkedBy: 'cwd', startedAt: now, linkedDirs: [] };
    if (!Array.isArray(record.linkedDirs)) record.linkedDirs = [];
    if (!record.agent) record.agent = agentName(sid);
    record.state = state;
    record.updatedAt = now;
    record.cwd = cwd;
    if (typeof input.transcript_path === 'string') record.transcriptPath = input.transcript_path;
    const text = String(input.message || input.prompt || '').trim().slice(0, 200);
    if (event === 'Notification') record.message = text || undefined;
    else if (event !== 'PostToolUse') delete record.message;
    if (event === 'UserPromptSubmit' && !record.firstPrompt && text) record.firstPrompt = text;
    const tool = input.tool_input || {};
    const edited = typeof tool.file_path === 'string' ? tool.file_path : typeof tool.notebook_path === 'string' ? tool.notebook_path : undefined;
    if (event === 'PostToolUse' && edited) {
      const other = gitDir(path.dirname(path.resolve(cwd, edited)));
      if (other && path.resolve(other) !== path.resolve(own) && !record.linkedDirs.includes(other)) record.linkedDirs.push(other);
    }
    write(own, record);
    for (const dir of record.linkedDirs) {
      if (typeof dir !== 'string' || !path.isAbsolute(dir) || unlinked(dir)) continue;
      const previous = read(fileFor(dir));
      write(dir, Object.assign({}, record, { linkedBy: previous && previous.linkedBy === 'manual' ? 'manual' : 'edit', linkedDirs: [] }));
    }
  }
}
// A new chat learns about the repository's backlog (how to read it and add tickets) from its guide, if it has one.
if (event === 'SessionStart') {
  try {
    const common = cp.execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: input.cwd || process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    const guide = path.join(path.dirname(common), '.flotilla', 'backlog', 'AGENTS.md');
    if (fs.existsSync(guide) && sid) {
      const name = agentName(sid);
      const context = fs.readFileSync(guide, 'utf8') + '\n\nIn this chat you are agent ' + name + ' (unless your first message gives you another name): sign your ticket reports "Agent ' + name + '" and use "agent: ' + name + '" in inbox files.\n';
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
    }
  } catch (e) {}
}
`;

/** Marks Flotilla's hook commands so a reinstall can find and replace them. */
export const HOOK_MARKER = 'flotilla-hook';

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'] as const;

/** Where the hook script is installed, relative to a worktree (next to its settings.local.json). */
export const HOOK_FILE = '.claude/flotilla-hook.js';

/** The code the hook runs. */
export function hookSource(): string {
  return `try {\n${SOURCE}\n} catch (e) {}`;
}

/** The installed hook file: the code with a header saying what it is. */
export function hookFileContent(): string {
  return [
    '// Flotilla hook for Claude Code (https://github.com/archipelagic-chef/flotilla).',
    '// Installed by the Flotilla VS Code extension; reinstalling the hooks overwrites this file.',
    '// It records each chat\'s state (working, waiting for input, done) in this worktree\'s git directory,',
    '// in flotilla/chats/<session>.json, so Flotilla can show it, and gives new chats the backlog\'s guide',
    '// (.flotilla/backlog/AGENTS.md) so agents can add tickets. It sends nothing anywhere.',
    hookSource(),
    '',
  ].join('\n');
}

/**
 * The hook command in settings.local.json: loads the hook file from the session's project folder (Claude Code sets
 * CLAUDE_PROJECT_DIR for hooks). No characters that sh, cmd or PowerShell interpret inside double quotes.
 */
export function hookCommand(): string {
  return `node -e "require(require('path').join(process.env.CLAUDE_PROJECT_DIR||process.cwd(),'.claude','flotilla-hook.js'))" ${HOOK_MARKER}`;
}
