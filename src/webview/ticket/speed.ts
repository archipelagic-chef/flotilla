/**
 * The speed demos play at (BL-218): one for every demo in the tab, the user's last pick. The host keeps it (in
 * Flotilla's global state), so every ticket's tab plays at it, after a reload too; the ticket's view brings it.
 */
import { useEffect, useState } from 'preact/hooks';
import {
  type DemoSpeed,
  demoSpeed,
  frameDelay,
  gifDelays,
} from '../../features/backlog/demo';
import { send } from './actions';

let speed: DemoSpeed = 1;
const listeners = new Set<(speed: DemoSpeed) => void>();

export function currentSpeed(): DemoSpeed {
  return speed;
}

/** The speed as the host kept it (each view of the ticket brings it). */
export function keptSpeed(value: unknown) {
  const next = demoSpeed(value);
  if (next === speed) return;
  speed = next;
  listeners.forEach((f) => f(speed));
}

/** The user picked a speed: every demo plays at it, and the host keeps it. */
export function pickSpeed(value: number) {
  const next = demoSpeed(value);
  keptSpeed(next);
  send({ type: 'demoSpeed', speed: next });
}

export function onSpeed(f: (speed: DemoSpeed) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function useSpeed(): DemoSpeed {
  const [shown, setShown] = useState(speed);
  useEffect(() => {
    setShown(speed);
    return onSpeed(setShown);
  }, []);
  return shown;
}

/** What WebCodecs' ImageDecoder gives (VS Code's webviews have it); not in the DOM types this builds with. */
interface Decoder {
  tracks: { ready: Promise<void>; selectedTrack?: { frameCount: number } };
  decode(options: { frameIndex: number }): Promise<{ image: CanvasImageSource & { displayWidth: number; displayHeight: number; close(): void } }>;
  close(): void;
}
declare const ImageDecoder: (new (init: { data: ArrayBuffer; type: string }) => Decoder) | undefined;

/**
 * A GIF played on a canvas, each frame's delay divided by the speed: an <img> can't change its speed. `ready` is false
 * when it can't be decoded (no ImageDecoder, or not a GIF): the <img> shows it then.
 */
export class GifPlayer {
  private decoder?: Decoder;
  private delays: number[] = [];
  private frames = 0;
  private frame = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private gone = false;
  private speed = 1;
  readonly ready: Promise<boolean>;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    src: string,
  ) {
    this.ready = this.load(src).catch(() => false);
  }

  private async load(src: string): Promise<boolean> {
    if (typeof ImageDecoder === 'undefined') return false;
    const bytes = await (await fetch(src)).arrayBuffer();
    if (this.gone) return false;
    this.delays = gifDelays(new Uint8Array(bytes)) ?? [];
    const decoder = new ImageDecoder({ data: bytes, type: 'image/gif' });
    await decoder.tracks.ready;
    this.frames = decoder.tracks.selectedTrack?.frameCount ?? 0;
    if (this.gone || this.frames < 1) {
      decoder.close();
      return false;
    }
    this.decoder = decoder;
    return true;
  }

  /** Plays it at a speed, from where it is; at 1× it stops (the <img> plays it). */
  play(speed: number) {
    this.speed = speed;
    if (this.timer !== undefined || speed === 1 || !this.decoder) return;
    void this.draw();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  close() {
    this.gone = true;
    this.stop();
    this.decoder?.close();
  }

  private async draw() {
    const decoder = this.decoder;
    if (!decoder || this.gone || this.speed === 1) return;
    const at = performance.now();
    try {
      const { image } = await decoder.decode({ frameIndex: this.frame });
      if (this.canvas.width !== image.displayWidth) this.canvas.width = image.displayWidth;
      if (this.canvas.height !== image.displayHeight) this.canvas.height = image.displayHeight;
      this.canvas.getContext('2d')?.drawImage(image, 0, 0);
      image.close();
    } catch {
      return;
    }
    if (this.gone || this.speed === 1) return;
    const wait = frameDelay(this.delays[this.frame], this.speed) - (performance.now() - at);
    this.frame = (this.frame + 1) % this.frames;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.draw();
      },
      Math.max(0, wait),
    );
  }
}

/** A GIF's source: a demo can be one (or a video). */
export const isGif = (src: string) => /\.gif(?:$|[?#])/i.test(src);

/**
 * Plays a GIF <img> at the speed, from now on: on a canvas after it, the <img> hidden, while it's faster than 1×; the
 * <img> as it is at 1× or when it can't be decoded. Returns what stops it.
 */
export function playGifAtSpeed(img: HTMLImageElement): () => void {
  const canvas = document.createElement('canvas');
  canvas.className = 'demo-gif';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', img.alt);
  canvas.hidden = true;
  img.after(canvas);
  const player = new GifPlayer(canvas, img.src);
  let decoded = false;
  const show = (s: number) => {
    const fast = decoded && s !== 1;
    canvas.hidden = !fast;
    img.hidden = fast;
    if (fast) player.play(s);
    else player.stop();
  };
  void player.ready.then((ok) => {
    decoded = ok;
    show(speed);
  });
  const off = onSpeed(show);
  return () => {
    off();
    player.close();
    canvas.remove();
    img.hidden = false;
  };
}

/** A video plays at the speed, from now on. Returns what stops following it. */
export function playVideoAtSpeed(video: HTMLVideoElement): () => void {
  const apply = (s: number) => {
    video.defaultPlaybackRate = s;
    video.playbackRate = s;
  };
  apply(speed);
  // A new source starts at the default rate; set it again once it's loaded.
  const loaded = () => apply(speed);
  video.addEventListener('loadedmetadata', loaded);
  const off = onSpeed(apply);
  return () => {
    off();
    video.removeEventListener('loadedmetadata', loaded);
  };
}

/** Plays every demo recording under a root at the speed: its videos, and its GIFs. Returns what stops it. */
export function playAtSpeed(root: ParentNode, selector: string): () => void {
  const stops = [...root.querySelectorAll<HTMLElement>(selector)].map((el) =>
    el instanceof HTMLVideoElement ? playVideoAtSpeed(el) : el instanceof HTMLImageElement && isGif(el.src) ? playGifAtSpeed(el) : () => undefined,
  );
  return () => stops.forEach((s) => s());
}
