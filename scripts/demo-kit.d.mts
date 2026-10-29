export const ACTIONS: string[];
export const DEMOS_DIR: string;
export const GIF_MAX_MS: number;
export const TITLE_MARKER: string;
export const FRAME_MS: number;

export interface DemoStep {
  action: 'command' | 'click' | 'hover' | 'type' | 'press' | 'waitFor' | 'wait' | 'caption' | 'highlight' | 'agentTurn' | 'gitHubComment';
  value: string | number;
  timeout?: number;
}

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export function parseDemo(
  text: string,
  name?: string,
): { title: string; steps: DemoStep[]; settings: Record<string, unknown>; runsOnPush: boolean; githubSignedOut: boolean };
export function demoFile(root: string, name: string | undefined): string;
export function listDemos(root: string): string[];
export function unsafeFrame(frame: { title?: string; argv?: string[] }, options: { profileDir: string }): string | undefined;
export function stepsToPlay<S>(demo: { steps: S[] }, mode: 'record' | 'play' | 'try' | 'check'): S[];
export function demoDisplay(env: Record<string, string | undefined>): 'virtual' | 'screen';
export function freeDisplay(exists: (file: string) => boolean, from?: number): number;
export function decodePng(buffer: Buffer): RgbaImage;
export function downscale(image: RgbaImage, maxWidth: number): RgbaImage;
export function frameGate<F>(check: () => Promise<string | undefined>): {
  readonly kept: F[];
  readonly unsafe: string | undefined;
  add(frame: F): void;
  check(): Promise<string | undefined>;
};
export function timeline(
  captures: { at: number; png: Buffer }[],
  endMs: number,
  options?: { captions?: { at: number; length: number }[]; highlights?: { at: number }[] },
): { png: Buffer; at: number; ms: number; cutMs: number }[];
export const STILL_MS: number;
export const CAPTION_MS_PER_CHAR: number;
export const HIGHLIGHT_MS: number;
export const CAPTION_MIN_MS: number;
export function recordingLength(frames: { ms: number; cutMs?: number }[]): { ms: number; cutMs: number };
export function lengthLine(length: { ms: number; cutMs: number }): string;
export function gapStats(ats: number[], moves: [number, number][]): { median: number; p90: number; count: number } | undefined;
export const DEMO_TAG: string;
export function tagGif(gif: Buffer, name: string): Buffer;
export function encodeGif(frames: { png: Buffer; ms: number }[], options?: { maxWidth?: number; name?: string }): Buffer;
export function parseJsonc(text: string): Record<string, unknown> | undefined;
export const BUILT: string[];
export function staleBuild(root: string): string | undefined;
export function failureReason(error: unknown): string;
export function nearestElements(selector: string, elements: { tag: string; text?: string; label?: string; classes?: string }[], count?: number): string[];
export function resultLine(
  result:
    { saved: string; bytes: number; ms: number; cutMs?: number } | { checked: number; ms: number } | { step?: string; reason: string; screenshot?: string },
): string;
export function plainSettings(file: string): 'kept' | 'rewritten' | 'moved';
export function commandMatches(typed: string, label: string | undefined | null): boolean;
