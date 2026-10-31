#!/usr/bin/env node
// How agents use the demo recorder (BL-195), from Claude Code's transcripts (~/.claude/projects/<folder>/<session>.jsonl)
// and the demo events (demo-recorded, demo-checked, demo-failed): per agent session, the recorder's runs and recordings
// (median, p90, max), and the failures by kind. Only commands that ran the recorder count, not greps of its source or
// text in a heredoc.
//
//   npm run bench:demos -- --since 2026-10-25T04:46Z                   from then on
//   npm run bench:demos -- --since 2026-10-25T04:46Z --days 7          a week of it
//   npm run bench:demos -- --until 2026-10-24T17:23Z                   everything before then
//   npm run bench:demos -- --match BL-55                               transcript folders whose name contains this
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sinceTime } from './bench-tokens.mjs';

const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?:\n|$)/g;
const SEPARATOR = /&&|\|\||;|\||\n|\$\(|`|\(|\)/;
const PREFIX = /^(?:\w+=\S*\s+|timeout\s+(?:-\S+\s+)*\d+\w?\s+|env\s+|xvfb-run\s+(?:-\S+\s+)*|exec\s+|time\s+)*/;
const RUN = /^(?:npm run demo(?:\s+--)?|node\s+(?:\S*\/)?scripts\/demo\.mjs)\s+(record|check|play|list)\b\s*(\S*)/;

/** The recorder's runs in a shell command, each its mode and demo: not a grep of it, nor its text in a heredoc. */
export function demoRuns(command) {
  const runs = [];
  for (const part of command.replace(HEREDOC, '\n').split(SEPARATOR)) {
    const m = RUN.exec(
      part
        .trim()
        .replace(/^\{\s*/, '')
        .replace(PREFIX, ''),
    );
    if (m) runs.push({ mode: m[1], name: m[2].replace(/^['"]|['"]$/g, '') });
  }
  return runs;
}

/** The value at a share of a list of numbers (0.5 the median, 0.9 the p90): the smallest that many are at or under. */
export function quantile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : 0;
}

/** What a failure was: the demo's (a step it couldn't do) or the recorder's own (before the first step, the window). */
export function failureKind(e) {
  const reason = e.reason ?? '';
  if (/Application exited/.test(reason)) return 'recorder: the window closed';
  if (/window's title isn't the demo window's/.test(reason)) return 'recorder: not the demo window';
  if (/aria-label="Backlog"\]/.test(reason)) return 'recorder: the Backlog view not ready';
  if (e.step === undefined || e.step === null) return 'before the first step: ' + reason.replace(/\d+/g, 'N').slice(0, 60);
  if (/^nothing visible matches|^locator\.\w+: Timeout/.test(reason)) return "demo: a step's element not found";
  return 'demo: ' + reason.replace(/\d+/g, 'N').slice(0, 60);
}

/** An agent session's recorder runs in a window, from its transcript's entries; undefined when it's no agent's. */
export function sessionRuns(entries, from, until) {
  let agent = false;
  let active = false;
  const runs = [];
  for (const e of entries) {
    const content = e.message?.content;
    if (e.type === 'user') {
      const text = typeof content === 'string' ? content : (content ?? []).map((c) => c?.text ?? '').join(' ');
      if (/working on backlog item|You are agent \w+-\d/.test(text)) agent = true;
    }
    const at = e.timestamp ?? '';
    if (!at || at < from || at >= until) continue;
    active = true;
    if (!Array.isArray(content)) continue;
    for (const c of content) if (c?.type === 'tool_use' && c.name === 'Bash') runs.push(...demoRuns(c.input?.command ?? '').map((r) => r.mode));
  }
  return agent && active ? runs : undefined;
}

function readEntries(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n'))
    try {
      if (line) out.push(JSON.parse(line));
    } catch {
      // a line being written
    }
  return out;
}

function demoEvents(from, until) {
  const common = path.resolve(execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim());
  const dir = path.join(common, 'flotilla', 'metrics');
  const out = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^events-\d{4}-\d{2}\.jsonl$/.test(n)) : [])
    for (const e of readEntries(path.join(dir, f))) if (e.kind?.startsWith('demo-') && e.at >= from && e.at < until) out.push(e);
  return out;
}

function main(args) {
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const from = opt('--since') ? sinceTime(opt('--since')) : '0000';
  const days = Number(opt('--days'));
  const until = opt('--until') ? sinceTime(opt('--until')) : days ? new Date(Date.parse(from) + days * 86_400_000).toISOString() : '9999';
  if (!from || !until) {
    console.error('Not a date or time: --since or --until');
    process.exit(1);
  }
  const match = (opt('--match') ?? 'worktree-extension').toLowerCase();
  const root = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');

  const sessions = [];
  for (const folder of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    if (!folder.toLowerCase().includes(match)) continue;
    for (const f of fs.readdirSync(path.join(root, folder)))
      if (f.endsWith('.jsonl')) {
        const runs = sessionRuns(readEntries(path.join(root, folder, f)), from, until);
        if (runs) sessions.push(runs);
      }
  }
  const line = (label, values) => `${label} median ${quantile(values, 0.5)}, p90 ${quantile(values, 0.9)}, max ${quantile(values, 1)}`;
  const runs = sessions.map((s) => s.length);
  const recordings = sessions.map((s) => s.filter((m) => m === 'record').length);
  const users = sessions.filter((s) => s.length);
  const modes = {};
  for (const m of sessions.flat()) modes[m] = (modes[m] ?? 0) + 1;
  console.log(`${sessions.length} agent sessions from ${from} to ${until}, ${users.length} of them ran the recorder`);
  console.log(
    `  runs: ${
      Object.entries(modes)
        .map(([m, n]) => `${n} ${m}`)
        .join(', ') || 'none'
    }`,
  );
  console.log(
    `  ${line('runs per session:', runs)}; of those that ran it: ${line(
      '',
      users.map((s) => s.length),
    ).trim()}`,
  );
  console.log(
    `  ${line('recordings per session:', recordings)}; of those that ran it: ${line(
      '',
      users.map((s) => s.filter((m) => m === 'record').length),
    ).trim()}`,
  );

  const events = demoEvents(from, until);
  const count = (kind) => events.filter((e) => e.kind === kind).length;
  console.log(`\nEvents: ${count('demo-recorded')} recorded, ${count('demo-checked')} checked, ${count('demo-failed')} failed`);
  const kinds = {};
  for (const e of events.filter((e) => e.kind === 'demo-failed')) {
    const k = `${failureKind(e.data ?? {})} (${e.data?.mode ?? '?'})`;
    kinds[k] = (kinds[k] ?? 0) + 1;
  }
  for (const [k, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
