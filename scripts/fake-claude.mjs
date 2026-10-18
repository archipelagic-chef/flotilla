#!/usr/bin/env node
// A stand-in for the claude CLI, to try Flotilla's agents (the autopilot, reviews, usage limits and resumes) in the
// debug window in seconds and without any usage. It takes the arguments Flotilla passes and answers as Claude Code does
// with `-p --output-format json`. As an implementer it commits a small change in its worktree and reports in the
// ticket; as a reviewer it gives a verdict. What it does follows hints in the ticket's description, lines "fake: …"
// (directives separated by commas):
//
//   fake: wait 20s          takes that long before it answers (default 3s; a bare number is seconds)
//   fake: changes           the reviewer asks for changes once, then approves
//   fake: changes forever   the reviewer asks for changes every time
//   fake: ask               the implementer asks first ("Waiting for you."), and goes on once the user has answered
//   fake: limit 2m          its first run hits a usage limit that resets in 2 minutes; the resumed run goes on
//   fake: crash             its first run dies without reporting; the resumed run goes on
//
// Try it: in the debug window's settings, set "flotilla.agents.claudePath" to the absolute path of this file (it must
// be executable: chmod +x scripts/fake-claude.mjs). It's not part of the published extension (.vscodeignore).
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const args = process.argv.slice(2);
const option = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const prompt = option('-p') ?? '';
const resume = option('--resume');
const name = option('--name') ?? '';
const session = resume ?? option('--session-id') ?? crypto.randomUUID();
const started = Date.now();

// "Ada-3 · BL-33" (an implementer), "Ada-3 · review BL-33" (a reviewer): the name Flotilla gives the chat.
const who = name.split('·')[0].trim() || 'Fake';
const reviewer = /·\s*review\s/.test(name);
const item = /·\s*(?:review\s+)?([A-Z]+-\d+)\s*$/.exec(name)?.[1] ?? /backlog item ([A-Z]+-\d+)/.exec(prompt)?.[1];

const reply = (result, isError = false) => {
  const out = { type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, duration_ms: Date.now() - started, num_turns: 1, result, session_id: session, total_cost_usd: 0 };
  process.stdout.write(`${JSON.stringify(out)}\n`);
};

const git = (...a) => execFileSync('git', a, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const stamp = (now = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
};

/** The ticket: the one the prompt names, else the item's in the backlog of this repository (the main checkout's). */
function ticketFile() {
  if (!item) return undefined;
  const named = new RegExp(`(/[^\\s"'\`()]*/${item}\\.md)`).exec(prompt)?.[1];
  if (named && fs.existsSync(named)) return named;
  const common = path.resolve(process.cwd(), git('rev-parse', '--git-common-dir'));
  const file = path.join(path.dirname(common), '.flotilla', 'backlog', `${item}.md`);
  return fs.existsSync(file) ? file : undefined;
}

/** The hints in the description (above "## Activity"): "fake: …" lines, directives separated by commas. */
function directives(text) {
  const description = text.split(/^##\s+Activity\s*$/im)[0];
  return [...description.matchAll(/^\s*fake:\s*(.+?)\s*$/gim)].flatMap((m) => m[1].split(/\s*[,;]\s*/)).map((d) => d.trim().toLowerCase());
}

/** A directive's argument ("" for a bare one), or undefined when it isn't there. */
function directive(list, word) {
  const hit = list.find((d) => d === word || d.startsWith(`${word} `));
  return hit === undefined ? undefined : hit.slice(word.length).trim();
}

/** "20s", "2m", "1h" (a bare number is in the default unit). */
function duration(text, unit) {
  const m = /^(\d+)\s*(s|m|h)?$/.exec(text ?? '');
  if (!m) return undefined;
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? unit];
}

/** Adds an entry at the end of the ticket's Activity (adding the section if it's missing). */
function appendEntry(file, body) {
  const entry = `### ${stamp()} · Agent ${who}\n${body.trim()}\n`;
  const text = fs.readFileSync(file, 'utf8');
  const sep = text.endsWith('\n') ? '\n' : '\n\n';
  if (/^##\s+Activity\s*$/im.test(text)) fs.appendFileSync(file, `${sep}${entry}`);
  else fs.appendFileSync(file, `${sep}## Activity\n\n${entry}`);
}

const hasEntryBy = (text, author) => new RegExp(`^###\\s+.*·\\s*${author}\\s*$`, 'im').test(text.split(/^##\s+Activity\s*$/im)[1] ?? '');

/** The implementer's change: one more line in a file of the item's, committed with the item's id. */
function change(id) {
  // Repository-relative, with /: it goes into the report's links (and fs takes / on Windows too).
  const rel = path.posix.join('fake-work', `${id}.txt`);
  fs.mkdirSync(path.dirname(rel), { recursive: true });
  const n = fs.existsSync(rel) ? fs.readFileSync(rel, 'utf8').split('\n').filter(Boolean).length + 1 : 1;
  fs.appendFileSync(rel, `${stamp()} · ${who} · change ${n}\n`);
  const line = fs.readFileSync(rel, 'utf8').split('\n').filter(Boolean).length;
  git('add', rel);
  git('commit', '-q', '-m', `${id}: fake change ${n} by ${who}`);
  return { rel, n, line, sha: git('rev-parse', '--short', 'HEAD') };
}

async function main() {
  const file = ticketFile();
  const text = file ? fs.readFileSync(file, 'utf8') : '';
  const hints = directives(text);

  if (!file || !item) {
    reply(`Fake Claude (scripts/fake-claude.mjs). Nothing to do without a backlog ticket: ${prompt.slice(0, 80)}`);
    return;
  }

  await new Promise((r) => setTimeout(r, duration(directive(hints, 'wait'), 's') ?? 3000));
  const fresh = resume === undefined;

  if (fresh && directive(hints, 'crash') !== undefined) {
    process.stderr.write('fake-claude: crashed on purpose (fake: crash)\n');
    process.exitCode = 1;
    return;
  }
  if (fresh && directive(hints, 'limit') !== undefined) {
    const ms = duration(directive(hints, 'limit'), 'm') ?? 120_000;
    // The reset as Claude Code says it: seconds since the epoch.
    reply(`Claude AI usage limit reached|${Math.floor((Date.now() + ms) / 1000)}`, true);
    process.exitCode = 1;
    return;
  }

  if (reviewer) return review(file, text, hints, item);
  return implement(file, text, hints, item);
}

function review(file, text, hints, id) {
  const asked = /^\s*\**\s*verdict\s*\**\s*:\s*changes requested/im.test(text);
  const changes = directive(hints, 'changes');
  const wantsChanges = changes === 'forever' || (changes !== undefined && !asked);
  const body = wantsChanges
    ? `Fake review: one more change, so the loop has something to do.\n\n- [ ] Make another change on the branch (the fake implementer adds a line to \`fake-work/${id}.txt\`).\n\nVerdict: changes requested`
    : `Fake review: the change is small and committed, and nothing in the ticket is left out, as far as a fake can tell.\n\nVerdict: approved`;
  appendEntry(file, body);
  reply(wantsChanges ? 'Fake review: changes requested.' : 'Fake review: approved.');
}

function implement(file, text, hints, id) {
  if (directive(hints, 'ask') !== undefined && !hasEntryBy(text, 'You')) {
    appendEntry(file, `Plan: a small change in \`fake-work/${id}.txt\`.\n\nQuestion: is one line per run enough, or should the fake change be bigger?\n\nWaiting for you.`);
    reply('Fake implementer: asked a question in the ticket.');
    return;
  }
  const done = change(id);
  appendEntry(
    file,
    [
      `Plan: a small change in \`${done.rel}\`: one line per run, so every run leaves a commit to review.`,
      `Done: committed ${done.sha} (\`${id}: fake change ${done.n} by ${who}\`).`,
      '#### How to review',
      '',
      `1. [${done.rel}](${done.rel}#L${done.line}): the line this run added.`,
      '',
      'How to try it:',
      '',
      '```sh',
      `cat ${done.rel}`,
      '```',
      '',
      "Nothing's left: this is a fake agent, and it changes nothing that matters.",
      '',
      'Ready for review.',
    ].join('\n'),
  );
  reply(`Fake implementer: committed ${done.sha} and reported in the ticket.`);
}

main().catch((e) => {
  process.stderr.write(`fake-claude: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
