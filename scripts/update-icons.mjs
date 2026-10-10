// Copies VS Code's Seti file icon theme into media/seti/, with a table of the file extensions and file names of every
// language VS Code ships. Flotilla falls back to these when the user's icon theme or language extensions aren't
// installed where Flotilla runs (in a devcontainer they run on the host).
//
// Usage: node scripts/update-icons.mjs <path to a VS Code installation>
// e.g.   node scripts/update-icons.mjs .vscode-test/vscode-linux-x64-1.141.0
import * as fs from 'node:fs';
import * as path from 'node:path';

const install = process.argv[2];
if (!install) {
  console.error('Usage: node scripts/update-icons.mjs <path to a VS Code installation>');
  process.exit(1);
}
const candidates = [path.join(install, 'resources', 'app', 'extensions'), path.join(install, 'Contents', 'Resources', 'app', 'extensions')];
const extensions = candidates.find((p) => fs.existsSync(p));
if (!extensions) {
  console.error(`No built-in extensions found under ${install}`);
  process.exit(1);
}

const out = path.resolve('media', 'seti');
fs.mkdirSync(out, { recursive: true });
const seti = path.join(extensions, 'theme-seti');
for (const file of ['icons/seti.woff', 'icons/vs-seti-icon-theme.json', 'ThirdPartyNotices.txt']) {
  fs.copyFileSync(path.join(seti, file), path.join(out, path.basename(file)));
}
const { version } = JSON.parse(fs.readFileSync(path.join(install, 'resources', 'app', 'package.json'), 'utf8'));

// Language id -> file extensions and file names, from every built-in extension (first one wins, like VS Code).
const languages = { extensions: {}, filenames: {} };
for (const dir of fs.readdirSync(extensions).sort()) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(extensions, dir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  for (const lang of pkg.contributes?.languages ?? []) {
    for (const e of lang.extensions ?? []) languages.extensions[e.replace(/^\./, '').toLowerCase()] ??= lang.id;
    for (const n of lang.filenames ?? []) languages.filenames[n.toLowerCase()] ??= lang.id;
  }
}
fs.writeFileSync(path.join(out, 'languages.json'), `${JSON.stringify({ vscode: version, ...languages }, null, 1)}\n`);
console.log(
  `Seti and ${Object.keys(languages.extensions).length} extensions / ${Object.keys(languages.filenames).length} file names from VS Code ${version} -> ${out}`,
);
