export const ACTIONS: string[];
export const DEMOS_DIR: string;
export const GIF_MAX_MS: number;
export const TITLE_MARKER: string;

export interface DemoStep {
  action: 'command' | 'click' | 'type' | 'press' | 'waitFor' | 'wait' | 'caption';
  value: string | number;
  timeout?: number;
}

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export function parseDemo(text: string, name?: string): { title: string; steps: DemoStep[]; settings: Record<string, unknown> };
export function demoFile(root: string, name: string | undefined): string;
export function listDemos(root: string): string[];
export function unsafeFrame(frame: { title?: string; argv?: string[] }, options: { profileDir: string }): string | undefined;
export function decodePng(buffer: Buffer): RgbaImage;
export function downscale(image: RgbaImage, maxWidth: number): RgbaImage;
export function timeline(captures: { at: number; png: Buffer }[], endMs: number): { png: Buffer; ms: number }[];
export function encodeGif(frames: { png: Buffer; ms: number }[], options?: { maxWidth?: number }): Buffer;
