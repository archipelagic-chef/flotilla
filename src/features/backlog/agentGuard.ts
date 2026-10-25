/**
 * The guard Flotilla's agents run before their tools (a PreToolUse hook, BL-75): it keeps large outputs out of their
 * context, which they'd re-read on every turn after. A Read of a big file without a line range, a plain `cat` of one,
 * or a whole `git diff`/`git show` of many lines is refused, with how to look instead, and how to get it whole anyway:
 * it steers, it doesn't forbid.
 *
 * `guard` is written into the hook's script as its source (see guardScript), so it uses nothing from outside itself.
 */
export function guard(
  input: { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string },
  maxLines: number,
  maxDiffLines: number,
): string | undefined {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const cp = require('node:child_process') as typeof import('node:child_process');
  const cwd = input.cwd || process.cwd();
  const tool = input.tool_input ?? {};
  const linesOf = (file: string): number | undefined => {
    try {
      const full = path.resolve(cwd, file);
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > 50 * 1024 * 1024) return undefined;
      const text = fs.readFileSync(full, 'utf8');
      if (text.includes('\u0000')) return undefined;
      return text.split('\n').length;
    } catch {
      return undefined;
    }
  };
  if (input.tool_name === 'Read') {
    const file = typeof tool.file_path === 'string' ? tool.file_path : undefined;
    if (!file || tool.limit !== undefined || tool.offset !== undefined || tool.pages !== undefined) return undefined;
    if (/\.(png|jpe?g|gif|webp|svg|pdf|ipynb)$/i.test(file)) return undefined;
    const n = linesOf(file);
    if (n === undefined || n <= maxLines) return undefined;
    return `${file} has ${n} lines, and what you read stays in your context for every later turn. Find what you need with Grep first, then Read just those lines (offset and limit). If you do need it whole, Read it again with limit: ${n}.`;
  }
  if (input.tool_name !== 'Bash' || typeof tool.command !== 'string') return undefined;
  const command = tool.command.trim();
  // Only a plain command: a pipe, a redirect or several commands mean it's already shaped.
  if (/[|;&<>`$]/.test(command)) return undefined;
  const cat = /^cat\s+("([^"]+)"|'([^']+)'|(\S+))$/.exec(command);
  if (cat) {
    const file = cat[2] ?? cat[3] ?? cat[4];
    const n = linesOf(file);
    if (n === undefined || n <= maxLines) return undefined;
    return `${file} has ${n} lines, and what you read stays in your context for every later turn. Find what you need with grep -n first, then print just those lines (sed -n 'FROM,TOp'). If you do need it whole, use sed -n '1,${n}p' ${file}.`;
  }
  const git = /^git\s+(?:-C\s+(\S+)\s+)?(diff|show)(\s.*)?$/.exec(command);
  if (git) {
    const rest = (git[3] ?? '').trim();
    // Already narrowed: a summary, paths, or a format of its own.
    if (/(^|\s)(--stat|--numstat|--shortstat|--name-only|--name-status|--summary|--format|--pretty|--oneline|-s|--no-patch|--)(\s|=|$)/.test(rest))
      return undefined;
    if (git[2] === 'show' && /:/.test(rest)) return undefined;
    let out: string;
    try {
      const args = ['-C', path.resolve(cwd, git[1] ?? '.'), git[2], '--numstat', '--format=', ...rest.split(/\s+/).filter(Boolean)];
      out = cp.execFileSync('git', args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return undefined;
    }
    let lines = 0;
    let files = 0;
    for (const row of out.split('\n')) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(row);
      if (!m) continue;
      files += 1;
      lines += (m[1] === '-' ? 0 : Number(m[1])) + (m[2] === '-' ? 0 : Number(m[2]));
    }
    if (lines <= maxDiffLines) return undefined;
    return `That ${git[2] === 'show' ? 'commit' : 'diff'} changes ${lines} lines in ${files} files, and what you read stays in your context for every later turn. Look at it with --stat first, then at the files you need (add -- <paths>). If you do need it whole, add -- . to the command.`;
  }
  return undefined;
}

/** The hook's script: reads the tool call from stdin; a refusal goes to stderr with exit code 2 (Claude Code shows it to the agent). */
export function guardScript(maxLines: number, maxDiffLines: number): string {
  return [
    "// Flotilla: keeps large outputs out of its agents' context (a PreToolUse hook). Written by the Flotilla extension.",
    `const guard = ${guard.toString()};`,
    "let raw = '';",
    "process.stdin.on('data', (d) => (raw += d));",
    "process.stdin.on('end', () => {",
    '  let why;',
    '  try {',
    `    why = guard(JSON.parse(raw), ${maxLines}, ${maxDiffLines});`,
    '  } catch {}',
    '  if (why) {',
    '    process.stderr.write(why);',
    '    process.exit(2);',
    '  }',
    '});',
    '',
  ].join('\n');
}
