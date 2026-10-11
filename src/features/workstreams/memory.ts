/** Whether there's too little free memory to start another agent (below the minimum; 0 never asks for room). */
export function isMemoryShort(freeMB: number, minMB: number): boolean {
  return freeMB < minMB;
}

/** A size for people: "900 MB", "2.4 GB". */
export function formatMemory(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
