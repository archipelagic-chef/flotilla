import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Writes `flotilla.checks.maxParallel` to <commonDir>/flotilla/checks.json, where test scripts that queue for the
 * machine read it (this repository's scripts/test.mjs). Writes only when it changed (the folder is watched). Returns
 * true when it wrote.
 */
export async function writeChecksConfig(commonDir: string, maxParallel: number): Promise<boolean> {
  const file = path.join(commonDir, 'flotilla', 'checks.json');
  const text = `${JSON.stringify({ maxParallel: Math.max(0, Math.floor(maxParallel) || 0) })}\n`;
  if ((await fs.readFile(file, 'utf8').catch(() => undefined)) === text) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
  return true;
}
