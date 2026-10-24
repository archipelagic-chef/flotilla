import * as fs from 'node:fs';
import type { Tokens } from './events';

/**
 * An agent run's tokens and model, read from its chat's transcript (BL-168): for a run in a terminal, which gives no
 * JSON result. Its replies since `since` (a resumed chat's earlier runs aren't this one's), each counted once (a reply's
 * lines carry the same usage), not a subagent's. A transcript has no cost: there's none to read. Empty when it can't be
 * read or has no replies.
 */
export async function transcriptUsage(file: string, since?: Date): Promise<{ tokens?: Tokens; model?: string }> {
  const text = await fs.promises.readFile(file, 'utf8').catch(() => '');
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const seen = new Set<string>();
  let tokens: Tokens | undefined;
  let model: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: { type?: unknown; isSidechain?: unknown; timestamp?: unknown; message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== 'assistant' || entry.isSidechain) continue;
    if (since && typeof entry.timestamp === 'string' && Date.parse(entry.timestamp) < since.getTime()) continue;
    const m = entry.message;
    if (typeof m?.model === 'string' && m.model !== '<synthetic>') model = m.model;
    const u = m?.usage;
    if (!u) continue;
    if (typeof m.id === 'string') {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
    }
    const t = tokens ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    tokens = {
      input: t.input + n(u.input_tokens),
      output: t.output + n(u.output_tokens),
      cacheRead: t.cacheRead + n(u.cache_read_input_tokens),
      cacheCreation: t.cacheCreation + n(u.cache_creation_input_tokens),
    };
  }
  return { ...(tokens ? { tokens } : {}), ...(model ? { model } : {}) };
}
