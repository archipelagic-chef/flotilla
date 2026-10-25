// `npm run merge-replay -- [--since 2026-10-14] [--until 2026-10-21] [--ref main] [--json]`: replays the merges of a
// period in memory (git merge-tree, nothing is checked out or changed) and counts how many conflicted, in how many
// places, and how many of those places were pure additions: both sides only added lines at the same spot, with
// nothing removed or changed (BL-155). The merges are the merge commits reachable from the ref: merges into it, and
// agents' merges of main into their branches.
import { execFileSync, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/**
 * The conflicts in a file merged with diff3 markers: per place, the lines of each side and of the base. A place is a
 * pure addition when its base is empty (both sides added lines there).
 */
export function conflictsOf(text) {
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
        pureAddition: place.base.length === 0,
        imports: [...place.ours, ...place.theirs].some((l) => /^\s*(import|export) .* from /.test(l)),
      });
      place = undefined;
    } else if (place) place[side].push(line);
  }
  return places;
}

/** Replays one merge: undefined when it merged cleanly, else its conflicted files with their places. */
export function replay(cwd, first, second) {
  const r = spawnSync('git', ['-c', 'merge.conflictStyle=diff3', 'merge-tree', '--write-tree', '--name-only', '-z', first, second], {
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
    files.push({ name, places: conflictsOf(text) });
  }
  return files;
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
  const range = ['rev-list', '--merges', '--parents', `--since=${since}`, ...(until ? [`--until=${until}`] : []), ref];
  const results = [];
  for (const line of git(range, cwd).split('\n').filter(Boolean)) {
    const [commit, first, second] = line.split(' ');
    results.push({ commit, files: replay(cwd, first, second) });
  }
  const s = summarize(results);
  if (argv.includes('--json')) return console.log(JSON.stringify({ since, until, ref, ...s }, null, 2));
  console.log(`Merges of ${ref} since ${since}${until ? ` until ${until}` : ''}: ${s.merges}`);
  console.log(`Conflicted: ${s.conflicted} (${pct(s.conflicted, s.merges)}), in ${s.places} places`);
  console.log(`Pure additions: ${s.pureAdditions} places (${pct(s.pureAdditions, s.places)}); in imports: ${s.imports} (${pct(s.imports, s.places)})`);
  if (s.mostConflicted.length) console.log(`Most conflicted: ${s.mostConflicted.map(([f, n]) => `${f} (${n})`).join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
