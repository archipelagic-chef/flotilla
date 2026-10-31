// A Prettier plugin: an import (or export list) of many names lists them one per line, sorted, so two branches
// that each add a name to it change different lines and merge without a conflict. Prettier alone joins them onto one
// line whenever they fit, where any two additions collide (BL-155).
import * as estree from 'prettier/plugins/estree';

/** From this many names on, an import lists them one per line: from two, so adding a name never rewraps the list (BL-252). */
export const ONE_PER_LINE = 2;

const base = estree.printers.estree;

/** The name a specifier is sorted by: what it imports (`a` of `a as b`), without `type`. */
function nameOf(s) {
  const n = s.type === 'ExportSpecifier' ? s.local : s.imported;
  return n?.name ?? n?.value ?? '';
}

export function compareNames(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The named specifiers of an import or re-export (not its default or `* as` one), or none for other nodes. */
function named(node) {
  if (node?.type === 'ImportDeclaration') return node.specifiers.filter((s) => s.type === 'ImportSpecifier');
  if (node?.type === 'ExportNamedDeclaration') return node.specifiers.filter((s) => s.type === 'ExportSpecifier');
  return [];
}

function isLong(node) {
  return named(node).length >= ONE_PER_LINE;
}

const start = (n) => n.range?.[0] ?? n.start;
const end = (n) => n.range?.[1] ?? n.end;

/** Sorts the names of long imports; one with a comment among its names keeps its order (the comment belongs where it is). */
function sortImports(ast) {
  const comments = ast.comments ?? [];
  for (const node of ast.body ?? []) {
    if (!isLong(node)) continue;
    if (comments.some((c) => start(c) > start(node) && end(c) < end(node))) continue;
    const specs = named(node);
    const sorted = [...specs].sort((a, b) => compareNames(nameOf(a), nameOf(b)));
    const others = node.specifiers.filter((s) => !specs.includes(s));
    node.specifiers = [...others, ...sorted];
  }
  return ast;
}

/** Breaks the `{ … }` group of a long import's doc, so each name gets its own line. */
function breakBraces(doc) {
  if (Array.isArray(doc)) return doc.map(breakBraces);
  if (doc && typeof doc === 'object' && doc.type === 'group' && Array.isArray(doc.contents) && doc.contents[0] === '{') return { ...doc, break: true };
  return doc;
}

export const printers = {
  estree: {
    ...base,
    preprocess: (ast, options) => sortImports(base.preprocess ? base.preprocess(ast, options) : ast),
    print(path, options, print, args) {
      const doc = base.print(path, options, print, args);
      return isLong(path.node) ? breakBraces(doc) : doc;
    },
  },
};
