import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const AGENT_STATES = ['working', 'waiting-for-input', 'done', 'error'] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export interface AgentStatus {
  state: AgentState;
  message?: string;
  updatedAt: Date;
}

export const AGENT_STATUS_FILE = 'workstream.json';

export function parseAgentStatus(text: string): AgentStatus | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const { state, message, updatedAt } = data as Record<string, unknown>;
  if (typeof state !== 'string' || !(AGENT_STATES as readonly string[]).includes(state)) return undefined;
  if (typeof updatedAt !== 'string') return undefined;
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return undefined;
  const trimmed = typeof message === 'string' ? message.trim() : '';
  return { state: state as AgentState, message: trimmed || undefined, updatedAt: date };
}

export async function readAgentStatus(gitDir: string, onInvalid?: (file: string) => void): Promise<AgentStatus | undefined> {
  const file = path.join(gitDir, AGENT_STATUS_FILE);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  const status = parseAgentStatus(text);
  if (!status) onInvalid?.(file);
  return status;
}

export async function clearAgentStatus(gitDir: string): Promise<void> {
  await fs.rm(path.join(gitDir, AGENT_STATUS_FILE), { force: true });
}
