import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Appends line to <commonDir>/info/exclude unless the file already has it or one of its variants. Returns true when it wrote. */
export async function ensureExcludeLine(commonDir: string, line: string, variants: readonly string[] = [line]): Promise<boolean> {
  const file = path.join(commonDir, 'info', 'exclude');
  let content = '';
  try {
    content = await fs.readFile(file, 'utf8');
  } catch {
    // no exclude file yet
  }
  const lines = content.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => variants.includes(l))) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const prefix = content === '' || content.endsWith('\n') ? '' : '\n';
  await fs.appendFile(file, `${prefix}${line}\n`);
  return true;
}
