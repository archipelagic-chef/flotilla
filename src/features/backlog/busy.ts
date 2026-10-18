import * as fs from 'node:fs/promises';

/** Commands that build or test: interrupting an agent in one of them loses that run. */
const BUILD_OR_TEST =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|check|lint)\b|\bnpx\s+(?:vitest|jest|tsc|esbuild)\b|\b(?:vitest|jest|mocha|pytest|tsc|esbuild|webpack|gradle|mvn)\b|\b(?:cargo|go|dotnet)\s+(?:build|test)\b|\bmake\s+(?:test|build|check)\b/;

/** The bytes at a transcript's end that are read: enough for the last few tool calls. */
const TAIL_BYTES = 512 * 1024;

/**
 * Whether a chat's transcript (its JSON lines) shows a build or a test run that hasn't returned: a Bash call with no
 * result yet, whose command builds or tests. Lines that don't parse are skipped.
 */
export function buildOrTestRunning(lines: readonly string[]): boolean {
  const open = new Map<string, string>();
  for (const line of lines) {
    let content: unknown;
    try {
      content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
    } catch {
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content as Array<Record<string, unknown>>) {
      if (part.type === 'tool_use' && part.name === 'Bash' && typeof part.id === 'string') {
        open.set(part.id, String((part.input as { command?: unknown } | undefined)?.command ?? ''));
      } else if (part.type === 'tool_result' && typeof part.tool_use_id === 'string') {
        open.delete(part.tool_use_id);
      }
    }
  }
  return [...open.values()].some((command) => BUILD_OR_TEST.test(command));
}

/** Whether the transcript file at `file` shows a build or a test running now (false if it can't be read). */
export async function transcriptBusy(file: string): Promise<boolean> {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split('\n');
      // The first line may be cut in the middle: it's dropped unless the file is read from its start.
      return buildOrTestRunning(start > 0 ? lines.slice(1) : lines);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}
