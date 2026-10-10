import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const HEARTBEAT_FILE = 'flotilla-window.json';
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_MAX_AGE_MS = 90_000;

export type WindowEnv = 'host' | 'container';

export interface Heartbeat {
  env: WindowEnv;
  os: string;
  updatedAt: Date;
}

/** True for the heartbeat file and its `<file>.<pid>.tmp` siblings, given a URI path (always `/`-separated). */
export function isHeartbeatPath(uriPath: string): boolean {
  return path.posix.basename(uriPath).startsWith(HEARTBEAT_FILE);
}

export function envFromRemoteName(remoteName: string | undefined): WindowEnv {
  return remoteName === 'dev-container' || remoteName === 'attached-container' ? 'container' : 'host';
}

export async function writeHeartbeat(gitDir: string, env: WindowEnv, os: string = process.platform, now: Date = new Date()): Promise<void> {
  const file = path.join(gitDir, HEARTBEAT_FILE);
  const content = JSON.stringify({ env, os, updatedAt: now.toISOString() });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content);
  try {
    await fs.rename(tmp, file); // atomic, so readers never see a half-written file
  } catch {
    await fs.rm(tmp, { force: true });
    await fs.writeFile(file, content);
  }
}

export async function readHeartbeat(gitDir: string): Promise<Heartbeat | undefined> {
  try {
    const data = JSON.parse(await fs.readFile(path.join(gitDir, HEARTBEAT_FILE), 'utf8')) as Record<string, unknown>;
    const updatedAt = new Date(String(data.updatedAt));
    if ((data.env !== 'host' && data.env !== 'container') || Number.isNaN(updatedAt.getTime())) return undefined;
    return { env: data.env, os: String(data.os ?? ''), updatedAt };
  } catch {
    return undefined;
  }
}

export function isAlive(hb: Heartbeat | undefined, now: Date): boolean {
  return hb !== undefined && now.getTime() - hb.updatedAt.getTime() <= HEARTBEAT_MAX_AGE_MS;
}

export async function deleteHeartbeat(gitDir: string): Promise<void> {
  await fs.rm(path.join(gitDir, HEARTBEAT_FILE), { force: true });
}
