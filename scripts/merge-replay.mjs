// `npm run merge-replay -- [--since 2026-10-14] [--until 2026-10-21] [--ref main] [--json]`: replays the merges of a
// period in memory (git merge-tree, nothing is checked out or changed) and counts how many conflicted, in how many
// places, and how many of those places were pure additions: both sides only added lines at the same spot, with
// nothing removed or changed (BL-155). The merges are the merge commits reachable from the ref: merges into it, and
// agents' merges of main into their branches.
//
// With `--landed`, it replays the tickets that landed on the ref as a straight line of commits (rebased and
// fast-forwarded, BL-181), which leaves no merge commits: per ticket, its change (the ref before its commits to after
// them) is merged with what landed on the ref since its branch was created (its reflog's "Created from"), as its
// rebase did (BL-187).
import {
  execFileSync,
  spawnSync,
} from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** Whether the lines of `part` appear in `whole`, in order (others between them). */
const within = (part, whole) => {
  let i = 0;
  for (const line of whole) if (line === part[i]) i++;
  return i === part.length;
};

/**
 * The conflicts in a file merged with diff3 markers: per place, the lines of each side and of the base. A place is a
 * pure addition when its base is empty (both sides added lines there). A landing's replay is merged the other way
 * round (`reversed`: base is the ref before the ticket, theirs undoes what landed since it started), so there a pure
 * addition is a place where ours only adds to the base and theirs only removes from it.
 */
export function conflictsOf(text, reversed = false) {
  const places = [];
  let place;
  let side;
  for (const line of text.split('\n')) {
    if (line.startsWith('<<<<<<< ')) {
      place = { ours: [], base: [], theirs: [] };
      side = 'ours';
    } else if (place && line.startsWith('||||||| ')) side = 'base';
    else if (place && line === '=======') side = 'theirs';
    else if (place && line.startsWith('>>>>>>> ')) {
      places.push({
        ...place,
        pureAddition: reversed ? within(place.base, place.ours) && within(place.theirs, place.base) : place.base.length === 0,
        imports: [...place.ours, ...place.theirs].some((l) => /^\s*(import|export) .* from /.test(l)),
      });
      place = undefined;
    } else if (place) place[side].push(line);
  }
  return places;
}

/**
 * Replays one merge: undefined when it merged cleanly, else its conflicted files with their places. Without a base,
 * git finds the merge base.
 */
export function replay(cwd, first, second, base, reversed = false) {
  const args = ['-c', 'merge.conflictStyle=diff3', 'merge-tree', '--write-tree', '--name-only', '-z'];
  if (base) args.push(`--merge-base=${base}`);
  const r = spawnSync('git', [...args, first, second], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status === 0) return undefined;
  if (r.status !== 1) throw new Error(r.stderr.trim() || `git merge-tree exited with ${r.status}`);
  // -z output: the tree, then the conflicted files, then an empty field before the messages.
  const [tree, ...rest] = r.stdout.split('\0');
  const files = [];
  for (const name of rest) {
    if (!name) break;
    if (files.some((f) => f.name === name)) continue;
    let text = '';
    try {
      text = git(['cat-file', '-p', `${tree}:${name}`], cwd);
    } catch {
      // Deleted on one side: a conflict without markers.
    }
    files.push({ name, places: conflictsOf(text, reversed) });
  }
  return files;
}

/**
 * The tickets that landed on the ref as runs of commits: per run, the ticket's id, the commit before its first one
 * and its last one. A ticket's merge commit ("Merge BL-12: ...") is a run of its own; other merges end a run.
 */
export function landings(cwd, ref, since, until) {
  const range = ['rev-list', '--first-parent', '--reverse', '--parents', '--format=%s', `--since=${since}`, ...(until ? [`--until=${until}`] : []), ref];
  const runs = [];
  let run;
  const lines = git(range, cwd).split('\n');
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const [, commit, parent, other] = lines[i].split(' ');
    const subject = lines[i + 1];
    const id = /^(?:Merge )?(\w+-\d+)\b/.exec(subject)?.[1];
    // A ticket merged into the ref (before BL-181) lands as its merge commit, a run of its own.
    if (other && id && subject.startsWith('Merge ')) runs.push((run = { id, before: parent, last: commit, merged: true }));
    else if (other || !id) run = undefined;
    else if (run?.id === id && run.last === parent) run.last = commit;
    else runs.push((run = { id, before: parent, last: commit }));
  }
  return runs;
}

/** The commit a ticket's branch was created from, by its reflog; undefined when no branch or reflog is left. */
export function branchStart(cwd, id) {
  const branches = git(['branch', '--list', '--format=%(refname:short)', `*/${id}-*`, `${id}-*`], cwd)
    .split('\n')
    .filter(Boolean);
  for (const branch of branches) {
    const log = spawnSync('git', ['reflog', 'show', '--format=%H %gs', branch], { cwd, encoding: 'utf8' }).stdout ?? '';
    const created = log.split('\n').find((l) => / branch: Created from /.test(l));
    if (created) return created.split(' ')[0];
  }
  return undefined;
}

/**
 * Replays a landed ticket's rebase: its change merged with what landed since it started. Undefined when it merged
 * cleanly (or nothing landed in between), else its conflicted files.
 */
export function replayLanding(cwd, { before, last }, start) {
  if (git(['rev-parse', start], cwd) === git(['rev-parse', before], cwd)) return undefined;
  return replay(cwd, last, start, before, true);
}

export function summarize(results) {
  const conflicted = results.filter((r) => r.files);
  const places = conflicted.flatMap((r) => r.files.flatMap((f) => f.places));
  const byFile = new Map();
  for (const r of conflicted) for (const f of r.files) byFile.set(f.name, (byFile.get(f.name) ?? 0) + 1);
  return {
    merges: results.length,
    conflicted: conflicted.length,
    places: places.length,
    pureAdditions: places.filter((p) => p.pureAddition).length,
    imports: places.filter((p) => p.imports).length,
    mostConflicted: [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}

const pct = (n, of) => (of ? `${Math.round((100 * n) / of)}%` : '–');

function main(argv) {
  const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const cwd = process.cwd();
  const ref = opt('ref', 'main');
  const since = opt('since', new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
  const until = opt('until');
  const landed = argv.includes('--landed');
  const results = [];
  const unknown = [];
  if (landed) {
    for (const run of landings(cwd, ref, since, until)) {
      const start = branchStart(cwd, run.id);
      if (start) results.push({ commit: run.last, id: run.id, files: replayLanding(cwd, run, start) });
      else unknown.push(run.id);
    }
  } else {
    const range = ['rev-list', '--merges', '--parents', `--since=${since}`, ...(until ? [`--until=${until}`] : []), ref];
    for (const line of git(range, cwd).split('\n').filter(Boolean)) {
      const [commit, first, second] = line.split(' ');
      results.push({ commit, files: replay(cwd, first, second) });
    }
  }
  const s = summarize(results);
  if (argv.includes('--json')) return console.log(JSON.stringify({ since, until, ref, landed, ...s, unknown }, null, 2));
  console.log(`${landed ? 'Tickets landed on' : 'Merges of'} ${ref} since ${since}${until ? ` until ${until}` : ''}: ${s.merges}`);
  if (unknown.length) console.log(`Not replayed (no branch reflog left): ${unknown.join(', ')}`);
  console.log(`Conflicted: ${s.conflicted} (${pct(s.conflicted, s.merges)}), in ${s.places} places`);
  console.log(`Pure additions: ${s.pureAdditions} places (${pct(s.pureAdditions, s.places)}); in imports: ${s.imports} (${pct(s.imports, s.places)})`);
  if (s.mostConflicted.length) console.log(`Most conflicted: ${s.mostConflicted.map(([f, n]) => `${f} (${n})`).join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
