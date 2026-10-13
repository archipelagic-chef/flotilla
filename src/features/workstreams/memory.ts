/** Whether there's too little free memory to start another agent (below the minimum; 0 never asks for room). */
export function isMemoryShort(freeMB: number, minMB: number): boolean {
  return freeMB < minMB;
}

/**
 * Too little free memory for another agent, once the agents starting now are counted (they aren't in the free memory
 * yet, see startingAgents.ts). The shortage it returns carries the free memory left after them.
 */
export function shortageAfterStarting(freeMB: number, startingMB: number, minMB: number): { freeMB: number; minMB: number } | undefined {
  const left = freeMB - startingMB;
  return isMemoryShort(left, minMB) ? { freeMB: left, minMB } : undefined;
}

/** A size for people: "900 MB", "2.4 GB". */
export function formatMemory(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
