import { type ExecFileOptions, execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';

/**
 * Starts processes on a worker thread (BL-165). Node's spawn waits for the child to start (fork and exec) on the
 * calling thread: usually 1–2 ms, but 50–150 ms on a busy machine, which blocked the extension host during a refresh of
 * many worktrees. On a worker, only the worker waits. Output and errors come back as execFile's callback gives them.
 */

export interface SpawnRequest {
  file: string;
  args: string[];
  options: Pick<ExecFileOptions, 'cwd' | 'timeout' | 'maxBuffer' | 'env' | 'windowsHide'> & { encoding: 'utf8' | 'buffer' };
  input?: string;
}

/** What execFile's callback gives, as far as callers read it. */
export interface SpawnResult<T> {
  error?: { message: string; code?: unknown };
  stdout: T;
  stderr: T;
}

// Plain JavaScript, so it runs from the bundle (dist/extension.js), the tests and the benchmarks alike.
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const { execFile } = require('node:child_process');
parentPort.on('message', ({ id, file, args, options, input }) => {
  try {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      parentPort.postMessage({ id, error: error ? { message: error.message, code: error.code } : undefined, stdout, stderr });
    });
    if (input !== undefined) child.stdin?.end(input);
  } catch (e) {
    parentPort.postMessage({ id, error: { message: String(e && e.message || e), code: e && e.code }, stdout: '', stderr: '' });
  }
});
`;

interface Spawner {
  worker: Worker;
  pending: Map<number, (result: SpawnResult<string | Uint8Array>) => void>;
}

let current: Spawner | undefined;
let workerFailed = false;
let nextId = 0;

/** Starts processes on the calling thread instead (for comparison in the benchmark; and the fallback). */
export let spawnOnMainThread = false;

export function setSpawnOnMainThread(on: boolean): void {
  spawnOnMainThread = on;
}

/** Runs `file` like execFile, on the worker thread when there is one. Output is a string or a Buffer, by encoding. */
export function spawnProcess(req: SpawnRequest): Promise<SpawnResult<string | Buffer>> {
  const s = spawnOnMainThread ? undefined : spawner();
  if (!s) return spawnHere(req);
  const id = nextId++;
  return new Promise((resolve) => {
    s.pending.set(id, (r) => {
      const toBuffer = (v: string | Uint8Array) => (typeof v === 'string' ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength));
      resolve({ error: r.error, stdout: toBuffer(r.stdout), stderr: toBuffer(r.stderr) });
    });
    // While a process runs, the worker keeps the process alive (as a child process would); idle, it doesn't.
    if (s.pending.size === 1) s.worker.ref();
    s.worker.postMessage({ id, ...req });
  });
}

function spawnHere(req: SpawnRequest): Promise<SpawnResult<string | Buffer>> {
  return new Promise((resolve) => {
    try {
      const child = execFile(req.file, req.args, req.options, (error, stdout, stderr) => {
        resolve({ error: error ? { message: error.message, code: (error as { code?: unknown }).code } : undefined, stdout, stderr });
      });
      if (req.input !== undefined) child.stdin?.end(req.input);
    } catch (e) {
      const empty = req.options.encoding === 'buffer' ? Buffer.alloc(0) : '';
      resolve({ error: { message: e instanceof Error ? e.message : String(e), code: (e as { code?: unknown }).code }, stdout: empty, stderr: empty });
    }
  });
}

function spawner(): Spawner | undefined {
  if (current || workerFailed) return current;
  try {
    const worker = new Worker(WORKER_SOURCE, { eval: true, name: 'Flotilla git' });
    const s: Spawner = { worker, pending: new Map() };
    worker.unref();
    worker.on('message', (msg: { id: number } & SpawnResult<string | Uint8Array>) => {
      const done = s.pending.get(msg.id);
      s.pending.delete(msg.id);
      if (s.pending.size === 0) worker.unref();
      done?.(msg);
    });
    // A worker that dies fails what it was running; the next process starts a new one.
    const lost = (message: string) => {
      if (current === s) current = undefined;
      for (const done of s.pending.values()) done({ error: { message }, stdout: '', stderr: '' });
      s.pending.clear();
    };
    worker.on('error', (e) => lost(`The git worker failed: ${e.message}`));
    worker.on('exit', (code) => lost(`The git worker stopped (exit ${code})`));
    current = s;
  } catch {
    // No worker threads here: start processes on this thread, as before.
    workerFailed = true;
  }
  return current;
}
