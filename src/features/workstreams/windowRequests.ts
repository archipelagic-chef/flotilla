import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Requests between Flotilla windows: one window asks the window open on a worktree to do something there (select a
 * chat), through files in that worktree's git dir (flotilla/requests/). Every window of the repository sees them,
 * whatever environment it runs in.
 */
export type WindowRequest = { type: 'openChat'; sessionId: string };

const DIR = path.join('flotilla', 'requests');
/** Older requests are dropped: whoever asked has given up by then. */
const MAX_AGE_MS = 30_000;

export async function sendWindowRequest(gitDir: string, request: WindowRequest): Promise<void> {
  const dir = path.join(gitDir, DIR);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(request));
  await fs.rename(`${file}.tmp`, file);
}

/** Takes the requests sent to this window (its worktree's git dir), oldest first; each is handled once. */
export async function takeWindowRequests(gitDir: string, now = Date.now()): Promise<WindowRequest[]> {
  const dir = path.join(gitDir, DIR);
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: WindowRequest[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const sent = Number(name.split('-')[0]);
    let text: string | undefined;
    try {
      text = await fs.readFile(file, 'utf8');
      await fs.rm(file, { force: true });
    } catch {
      continue; // another window instance took it
    }
    if (!Number.isFinite(sent) || now - sent > MAX_AGE_MS) continue;
    try {
      const r = JSON.parse(text) as WindowRequest;
      if (r?.type === 'openChat' && typeof r.sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(r.sessionId)) out.push(r);
    } catch {
      // not a request
    }
  }
  return out;
}
