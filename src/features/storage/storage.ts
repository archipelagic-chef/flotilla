import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Filesystems that are shares or VMs, where each file read crosses to another machine: WSL and dev containers mount
 * the Windows drive this way (9p, drvfs, virtiofs), and so do network drives.
 */
export const SLOW_FS_TYPES: ReadonlySet<string> = new Set([
  '9p',
  'drvfs',
  'virtiofs',
  'grpcfuse',
  'osxfs',
  'vboxsf',
  'vmhgfs',
  'cifs',
  'smb3',
  'smbfs',
  'nfs',
  'nfs4',
  'afs',
  'fuse.sshfs',
  'fuse.drvfs',
]);

/** A median stat above this is slow: a local disk answers in microseconds. */
export const SLOW_READ_MS = 1;

/** Where VS Code explains how to move a project to a faster file system (dev containers and WSL). */
export const SLOW_STORAGE_DOCS = 'https://code.visualstudio.com/remote/advancedcontainers/improve-performance';

export interface MountEntry {
  mountPoint: string;
  fsType: string;
}

export interface StorageReport {
  slow: boolean;
  /** The filesystem type, when the mount table says what it is (Linux). */
  fsType?: string;
  /** The median time to stat the repository's files, when that was measured (elsewhere). */
  readMs?: number;
}

function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/** Parses /proc/self/mountinfo: each mount point (octal escapes undone) and its filesystem type. */
export function parseMountInfo(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split('\n')) {
    // Optional fields end with a lone "-", then come the filesystem type and its source.
    const fields = line.split(' ');
    const dash = fields.indexOf('-');
    if (fields.length < 5 || dash < 5 || dash + 1 >= fields.length) continue;
    entries.push({ mountPoint: unescapeMountField(fields[4]), fsType: fields[dash + 1] });
  }
  return entries;
}

/** The filesystem type of the mount that holds dir: the longest mount point containing it (later mounts win ties). */
export function fsTypeOf(mounts: readonly MountEntry[], dir: string): string | undefined {
  let best: MountEntry | undefined;
  for (const mount of mounts) {
    // Mount tables are Linux's, so their paths are POSIX whatever runs this.
    const prefix = mount.mountPoint.endsWith('/') ? mount.mountPoint : mount.mountPoint + '/';
    const holds = dir === mount.mountPoint || dir.startsWith(prefix);
    if (holds && (!best || mount.mountPoint.length >= best.mountPoint.length)) best = mount;
  }
  return best?.fsType;
}

export function medianMs(samples: readonly number[]): number | undefined {
  if (!samples.length) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const PROBE_FILES = ['HEAD', 'config', 'index', 'packed-refs', 'info/exclude'];
const PROBE_ROUNDS = 4;

/**
 * Times stat() on the repository's own small files, synchronously (a few dozen calls). Undefined when there are none.
 * Used where the mount table can't say what the filesystem is.
 */
export function probeReadMs(gitDir: string): number | undefined {
  const files = PROBE_FILES.map((f) => path.join(gitDir, f)).filter((f) => fs.existsSync(f));
  const samples: number[] = [];
  for (let round = 0; round < PROBE_ROUNDS; round++) {
    for (const file of files) {
      const start = performance.now();
      fs.statSync(file);
      samples.push(performance.now() - start);
    }
  }
  return medianMs(samples);
}

/**
 * Whether the repository's storage is slow. The filesystem type decides when the mount table knows it; otherwise the
 * measured read time does (probe is only called then).
 */
export function storageReport(input: { dir: string; mounts: readonly MountEntry[] | undefined; probe: () => number | undefined }): StorageReport {
  const fsType = input.mounts ? fsTypeOf(input.mounts, input.dir) : undefined;
  if (fsType) return { slow: SLOW_FS_TYPES.has(fsType), fsType };
  const readMs = input.probe();
  return { slow: readMs !== undefined && readMs > SLOW_READ_MS, readMs };
}

/** What the user is told: why it's slow and how to fix it. Never a path. */
export function slowStorageText(report: StorageReport): { message: string; fix: string } {
  const why = report.fsType
    ? `This repository is on a slow drive (a ${report.fsType} file system).`
    : `This repository is on a slow drive (a file read takes about ${report.readMs?.toFixed(1) ?? '?'} ms here, well under 1 ms on a local disk).`;
  return {
    message: `${why} Git and Flotilla read many small files, and each one crosses to the other side, so git, builds, tests and reading tickets are slow.`,
    fix: 'Keep the repository on the file system of the container or of WSL: clone it into a container volume, or into WSL’s own file system.',
  };
}
