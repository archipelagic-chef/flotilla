#!/usr/bin/env node
// What agents' tokens go to, from Claude Code's transcripts (~/.claude/projects/<folder>/<session>.jsonl): per session
// its role (from its first prompt), model, turns, cache reads and writes, output and peak context; then what fills the
// context: each tool result's size times the turns it stays for (it's read again on each).
//
//   npm run bench:tokens                         this repository's worktrees, today
//   npm run bench:tokens -- --since 2026-10-17   from that day (ISO date or time)
//   npm run bench:tokens -- --match BL-55        transcript folders whose name contains this
//   npm run bench:tokens -- --session <id> ...   these sessions only
//   npm run bench:tokens -- --json               the numbers as JSON (one object per session)
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sessions = args.includes('--session') ? args.slice(args.indexOf('--session') + 1).filter((a) => !a.startsWith('--')) : [];
const since = opt('--since') ?? new Date().toISOString().slice(0, 10);
const match = opt('--match') ?? 'worktree-extension';
const json = args.includes('--json');
const root = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');

/** The role a session played, from its first prompt (Flotilla's agent prompts start the same way each time). */
function roleOf(first) {
  const head = first.slice(0, 600);
  if (/Review it:|\breviewer\b/i.test(head)) return 'reviewer';
  if (/talk(s)? it through|shaping/i.test(head)) return 'shaping';
  if (/You are agent/.test(head)) return 'implementer';
  return 'other';
}

/** What a tool call put in context, as a kind. */
function kindOf(use) {
  const name = use?.name ?? '?';
  if (name !== 'Bash') return name;
  const cmd = String(use.input?.command ?? '');
  if (/graphify/.test(cmd)) return 'Bash: graphify';
  if (/vitest|npm (run )?test/.test(cmd)) return 'Bash: tests';
  if (/typecheck|\btsc\b/.test(cmd)) return 'Bash: typecheck';
  if (/npm run build|esbuild/.test(cmd)) return 'Bash: build';
  if (/git (diff|show|log)/.test(cmd)) return 'Bash: git diff/log/show';
  if (/\b(cat|sed|head|tail)\b/.test(cmd)) return 'Bash: reading files';
  if (/\b(grep|rg|find)\b/.test(cmd)) return 'Bash: grep/find';
  return 'Bash: other';
}

function readSession(file) {
  const entries = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
  const s = { session: path.basename(file, '.jsonl'), folder: path.basename(path.dirname(file)), start: '', first: '', model: '', turns: 0, cacheRead: 0, cacheWrite: 0, input: 0, output: 0, peak: 0, kinds: {} };
  // One API response can be written over several lines: each message id counts once.
  const seen = new Set();
  const uses = new Map();
  const results = [];
  for (const e of entries) {
    if (!s.start && e.timestamp) s.start = e.timestamp;
    if (e.type === 'user' && !s.first) {
      const c = e.message?.content;
      s.first = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text ?? '').join(' ') : '';
    }
    if (e.type === 'assistant') {
      for (const c of e.message?.content ?? []) if (c.type === 'tool_use') uses.set(c.id, c);
      const u = e.message?.usage;
      const id = e.message?.id ?? e.uuid;
      if (u && !seen.has(id)) {
        seen.add(id);
        s.model = e.message.model ?? s.model;
        s.turns++;
        s.input += u.input_tokens ?? 0;
        s.cacheWrite += u.cache_creation_input_tokens ?? 0;
        s.cacheRead += u.cache_read_input_tokens ?? 0;
        s.output += u.output_tokens ?? 0;
        s.peak = Math.max(s.peak, (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0));
        for (const r of results) r.stays++;
      }
    }
    if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c.type !== 'tool_result') continue;
        const text = typeof c.content === 'string' ? c.content : (c.content ?? []).map((x) => x.text ?? '').join('');
        results.push({ kind: kindOf(uses.get(c.tool_use_id)), tokens: text.length / 4, stays: 0 });
      }
    }
  }
  for (const r of results) {
    const k = (s.kinds[r.kind] ??= { results: 0, tokens: 0, reread: 0 });
    k.results++;
    k.tokens += r.tokens;
    k.reread += r.tokens * r.stays;
  }
  s.role = roleOf(s.first);
  s.ticket = (s.first.match(/\b[A-Z][A-Z0-9]+-\d+\b/) ?? s.folder.match(/[A-Z]+-\d+/i) ?? ['-'])[0].toUpperCase();
  delete s.first;
  return s;
}

const files = [];
for (const folder of fs.existsSync(root) ? fs.readdirSync(root) : []) {
  if (!sessions.length && !folder.toLowerCase().includes(match.toLowerCase())) continue;
  for (const f of fs.readdirSync(path.join(root, folder))) {
    if (!f.endsWith('.jsonl')) continue;
    if (sessions.length && !sessions.includes(f.slice(0, -'.jsonl'.length))) continue;
    files.push(path.join(root, folder, f));
  }
}
const rows = files
  .map(readSession)
  .filter((s) => s.turns && (sessions.length || s.start >= since))
  .sort((a, b) => a.start.localeCompare(b.start));

if (json) {
  console.log(JSON.stringify(rows, null, 1));
  process.exit(0);
}
const k = (n) => `${(n / 1000).toFixed(0)}k`;
const sum = (list, f) => list.reduce((n, r) => n + f(r), 0);
console.log(`${rows.length} sessions${sessions.length ? '' : ` since ${since}, in transcript folders matching "${match}"`}\n`);
for (const r of rows) {
  console.log(
    `${r.start.slice(0, 16).replace('T', ' ')}  ${r.ticket.padEnd(7)} ${r.role.padEnd(11)} ${r.model.padEnd(20)} turns ${String(r.turns).padStart(4)}  read ${k(r.cacheRead).padStart(7)}  write ${k(r.cacheWrite).padStart(6)}  out ${k(r.output).padStart(5)}  peak ${k(r.peak).padStart(5)}`,
  );
}
console.log(`\nTotal: ${sum(rows, (r) => r.turns)} turns, cache read ${k(sum(rows, (r) => r.cacheRead))}, cache write ${k(sum(rows, (r) => r.cacheWrite))}, input ${k(sum(rows, (r) => r.input))}, output ${k(sum(rows, (r) => r.output))}`);
for (const role of ['implementer', 'reviewer', 'shaping', 'other']) {
  const rs = rows.filter((r) => r.role === role);
  if (rs.length) console.log(`  ${role.padEnd(11)} ${rs.length} sessions, ${sum(rs, (r) => r.turns)} turns, cache read ${k(sum(rs, (r) => r.cacheRead))}, output ${k(sum(rs, (r) => r.output))}`);
}
const kinds = {};
for (const r of rows) for (const [kind, v] of Object.entries(r.kinds)) {
  const t = (kinds[kind] ??= { results: 0, tokens: 0, reread: 0 });
  t.results += v.results;
  t.tokens += v.tokens;
  t.reread += v.reread;
}
const all = Object.values(kinds).reduce((n, v) => n + v.reread, 0) || 1;
console.log('\nWhat fills the context (tool results, and how much of them is read again on later turns):');
for (const [kind, v] of Object.entries(kinds).sort((a, b) => b[1].reread - a[1].reread)) {
  console.log(`  ${kind.padEnd(26)} ${String(v.results).padStart(4)} results  ${k(v.tokens).padStart(6)}  re-read ${k(v.reread).padStart(7)}  ${((100 * v.reread) / all).toFixed(0).padStart(3)}%`);
}
