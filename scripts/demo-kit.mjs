// The parts of the demo recorder (scripts/demo.mjs) that don't need a window: reading a demo's script, checking that a
// frame comes from the isolated window, and turning screenshots into a GIF (a PNG decoder, a downscale, the frames'
// timing and gifenc's encoder), so no ffmpeg is needed.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as gifencModule from 'gifenc';

// Node loads gifenc's CommonJS build (its functions on the default export), bundlers its ES one (named exports).
const { GIFEncoder, quantize, applyPalette } = gifencModule.default?.GIFEncoder ? gifencModule.default : gifencModule;

/** What a demo's step does: one of these keys, with its value. */
export const ACTIONS = ['command', 'click', 'hover', 'type', 'press', 'waitFor', 'wait', 'caption', 'agentTurn'];
/** The demos' folder, from the repository root; a demo is `demos/<name>.json`. */
export const DEMOS_DIR = 'demos';
/** Longer than this, a demo is an MP4 (when there's an ffmpeg: see findFfmpeg in demo.mjs); a GIF otherwise. */
export const GIF_MAX_MS = 15_000;
/** What the isolated window's title starts with: the demo profile sets it (window.title), and no other profile does. */
export const TITLE_MARKER = 'Flotilla demo';
/** VS Code puts this before the title of a window that runs an extension under development. */
const DEV_HOST = '[Extension Development Host] ';

/**
 * A demo's script, checked: `{ title?, steps: [{ <action>: value, timeout? }] }`. Throws with what's wrong (and the
 * step's number), so an agent can fix its script before anything is launched.
 */
export function parseDemo(text, name = 'demo') {
  let demo;
  try {
    demo = JSON.parse(text);
  } catch (error) {
    throw new Error(`${name}: not JSON (${error.message})`);
  }
  if (!demo || typeof demo !== 'object' || Array.isArray(demo)) throw new Error(`${name}: a demo is an object with "steps"`);
  if (!Array.isArray(demo.steps) || !demo.steps.length) throw new Error(`${name}: "steps" is a list of at least one step`);
  const steps = demo.steps.map((step, n) => {
    const where = `${name}, step ${n + 1}`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`${where}: a step is an object, such as { "click": "text=Create Worktree" }`);
    const actions = Object.keys(step).filter((k) => ACTIONS.includes(k));
    const unknown = Object.keys(step).filter((k) => !ACTIONS.includes(k) && k !== 'timeout');
    if (unknown.length) throw new Error(`${where}: unknown ${unknown.join(', ')} (a step is one of ${ACTIONS.join(', ')})`);
    if (actions.length !== 1) throw new Error(`${where}: a step does one thing: ${ACTIONS.join(', ')}`);
    const action = actions[0];
    const value = step[action];
    if (action === 'wait' ? !(Number.isFinite(value) && value >= 0) : typeof value !== 'string' || (action !== 'caption' && !value.trim())) {
      throw new Error(`${where}: "${action}" takes ${action === 'wait' ? 'a number of milliseconds' : 'a string'}`);
    }
    if (step.timeout !== undefined && !(Number.isFinite(step.timeout) && step.timeout > 0)) throw new Error(`${where}: "timeout" is a number of milliseconds`);
    return { action, value, ...(step.timeout ? { timeout: step.timeout } : {}) };
  });
  // Flotilla's settings the demo plays with (say, the local checks on Merge to main): only Flotilla's own.
  const settings = demo.settings ?? {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`${name}: "settings" is an object of Flotilla's settings`);
  const other = Object.keys(settings).filter((k) => !/^flotilla\.[\w.]+$/.test(k) || k.startsWith('flotilla.dev.'));
  if (other.length) throw new Error(`${name}: "settings" takes only Flotilla's settings (flotilla.*, not flotilla.dev.*), not ${other.join(', ')}`);
  return { title: typeof demo.title === 'string' ? demo.title : name, steps, settings };
}

/** A demo's file by name (letters, digits, - and _ only: a name isn't a path). */
export function demoFile(root, name) {
  if (!/^[\w-]+$/.test(name ?? '')) throw new Error(`"${name ?? ''}" isn't a demo's name: use letters, digits, - and _ (the file is ${DEMOS_DIR}/<name>.json)`);
  return path.join(root, DEMOS_DIR, `${name}.json`);
}

/** The demos in the repository, by name. */
export function listDemos(root) {
  try {
    return fs
      .readdirSync(path.join(root, DEMOS_DIR))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Why a frame mustn't be kept, or undefined when it comes from the isolated window: VS Code started with the demo's
 * own profile (`argv`: its main process's command line) and its window, whose title the demo profile sets.
 */
export function unsafeFrame({ title, argv }, { profileDir }) {
  const want = path.resolve(profileDir).toLowerCase();
  const dirs = (argv ?? []).flatMap((a) => (a.startsWith('--user-data-dir=') ? [path.resolve(a.slice('--user-data-dir='.length)).toLowerCase()] : []));
  if (dirs.length !== 1 || dirs[0] !== want) return `the window isn't VS Code with the demo profile (${profileDir})`;
  const shown = typeof title === 'string' && title.startsWith(DEV_HOST) ? title.slice(DEV_HOST.length) : title;
  if (typeof shown !== 'string' || !shown.startsWith(TITLE_MARKER)) return `the window's title isn't the demo window's ("${title ?? ''}")`;
  return undefined;
}

/** The steps a mode plays: all of them, except for `try` (Try it yourself, BL-135), which only sets the window up. */
export function stepsToPlay(demo, mode) {
  return mode === 'try' ? [] : demo.steps;
}

/**
 * Where the demo window opens (BL-102): `virtual`, a display of its own (Xvfb) that nobody sees, or `screen`, the
 * display it was started on. `DEMO_DISPLAY` says which; without it, it's virtual for an agent (Claude Code sets
 * `CLAUDECODE` in the commands its agents run), so an agent's demos never open windows on the user's screen.
 */
export function demoDisplay(env) {
  const asked = env.DEMO_DISPLAY?.trim().toLowerCase();
  if (asked === 'virtual' || asked === 'screen') return asked;
  if (asked) throw new Error(`DEMO_DISPLAY is "${env.DEMO_DISPLAY}": it's virtual or screen`);
  return env.CLAUDECODE ? 'virtual' : 'screen';
}

/**
 * The first display number from `from` up that nothing serves: neither an X socket (/tmp/.X11-unix/X<n>) nor a lock
 * (/tmp/.X<n>-lock). Xvfb's own pick looks at locks only, and the X forwarders of a dev container serve sockets
 * without them: it took the user's display (BL-102).
 */
export function freeDisplay(exists, from = 99) {
  for (let n = from; n < from + 1000; n++) if (!exists(`/tmp/.X11-unix/X${n}`) && !exists(`/tmp/.X${n}-lock`)) return n;
  throw new Error(`no free X display from :${from} up`);
}

/** A PNG (8-bit RGB or RGBA, not interlaced: what Chromium's screenshots are) as RGBA pixels. */
export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, color, , , interlace] = body.subarray(8, 13);
      channels = { 2: 3, 6: 4 }[color] ?? 0;
      if (depth !== 8 || !channels || interlace) throw new Error(`unsupported PNG (depth ${depth}, color type ${color}, interlace ${interlace})`);
    } else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      let p;
      if (filter === 0) p = 0;
      else if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else throw new Error(`bad PNG filter ${filter}`);
      out[x] = (line[x] + p) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = out[x * channels];
      rgba[i + 1] = out[x * channels + 1];
      rgba[i + 2] = out[x * channels + 2];
      rgba[i + 3] = channels === 4 ? out[x * channels + 3] : 255;
    }
    previous = out;
  }
  return { width, height, data: rgba };
}

/** Shrinks RGBA pixels to at most `maxWidth` wide (each pixel the average of the ones it covers); smaller ones stay. */
export function downscale(image, maxWidth) {
  if (image.width <= maxWidth) return image;
  const scale = image.width / maxWidth;
  const width = maxWidth;
  const height = Math.max(1, Math.round(image.height / scale));
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * scale);
    const y1 = Math.min(image.height, Math.max(y0 + 1, Math.floor((y + 1) * scale)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.min(image.width, Math.max(x0 + 1, Math.floor((x + 1) * scale)));
      const sum = [0, 0, 0, 0];
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * image.width + sx) * 4;
          for (let c = 0; c < 4; c++) sum[c] += image.data[i + c];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = Math.round(sum[c] / n);
    }
  }
  return { width, height, data: out };
}

/** The shortest a frame shows (ms): 25 a second, as smooth as a GIF plays in most viewers, and as an MP4 is made. */
export const FRAME_MS = 40;

/**
 * Frames, kept only once the window they came from is known to be the demo window (BL-133): `check` answers why it
 * isn't (unsafeFrame), or undefined. A check that passes keeps the frames that came before it started; one that fails
 * drops all that wait, and every frame after it.
 */
export function frameGate(check) {
  const pending = [];
  const kept = [];
  let unsafe;
  return {
    kept,
    get unsafe() {
      return unsafe;
    },
    add(frame) {
      if (!unsafe) pending.push(frame);
    },
    async check() {
      if (unsafe) return unsafe;
      const covered = pending.length;
      unsafe = await check();
      if (unsafe) pending.length = 0;
      else kept.push(...pending.splice(0, covered));
      return unsafe;
    },
  };
}

/**
 * The frames to show, as they were on screen: each capture (`at`: ms from the start, when it was drawn) shows until
 * the next one, and the last for `endMs - at`. Of those drawn before the start, only the last is kept, as the first
 * frame. Captures the same as the one before (byte for byte) only lengthen it, and of those drawn in the same FRAME_MS
 * (a step of 40 ms from the start), the last shows, from the step's start.
 */
export function timeline(captures, endMs) {
  const sorted = [...captures].sort((a, b) => a.at - b.at);
  const before = sorted.filter((c) => c.at <= 0).pop();
  const shown = [];
  for (const capture of [...(before ? [{ ...before, at: 0 }] : []), ...sorted.filter((c) => c.at > 0)]) {
    const last = shown[shown.length - 1];
    // On a grid of FRAME_MS, the last frame drawn in each step: 25 a second, evenly.
    const at = Math.floor(capture.at / FRAME_MS) * FRAME_MS;
    if (last && last.png.equals(capture.png)) continue;
    if (last && last.at === at) last.png = capture.png;
    else shown.push({ png: capture.png, at });
  }
  // Coming in later frames' place may have made one the same as the one before it.
  const merged = shown.filter((f, n) => n === 0 || !f.png.equals(shown[n - 1].png));
  return merged.map(({ png, at }, n) => {
    const ms = (n + 1 < merged.length ? merged[n + 1].at : Math.max(endMs, at)) - at;
    // GIF delays are in hundredths of a second: at least 2 (most viewers slow down faster frames anyway).
    return { png, at, ms: Math.max(20, Math.round(ms / 10) * 10) };
  });
}

/**
 * What a recording says it's a recording of (BL-111): `flotilla-demo:<name>`, in a GIF's comment and an MP4's, so that
 * the ticket pairs it with its `run demo <name>` block wherever the report puts them.
 */
export const DEMO_TAG = 'flotilla-demo:';

/** A GIF with a comment naming its demo, just before the trailer (where readers of the frames don't look). */
export function tagGif(gif, name) {
  const text = Buffer.from(DEMO_TAG + name, 'latin1');
  if (gif[gif.length - 1] !== 0x3b || text.length > 255) return gif;
  return Buffer.concat([gif.subarray(0, -1), Buffer.from([0x21, 0xfe, text.length]), text, Buffer.from([0x00, 0x3b])]);
}

/**
 * A GIF of the frames (PNG screenshots, each with how long it shows), at most `maxWidth` wide. Each frame after the
 * first holds only the pixels that changed (the others transparent, so the frame before shows through), with a palette
 * of their own: a pointer that moves costs a few small patches, not a whole window each time. `name`: its demo's.
 */
export function encodeGif(frames, { maxWidth = 960, name } = {}) {
  const gif = GIFEncoder();
  let previous;
  let pending;
  const flush = () => pending && gif.writeFrame(pending.index, pending.width, pending.height, pending.options);
  for (const frame of frames) {
    const image = downscale(decodePng(frame.png), maxWidth);
    const changed = [];
    if (previous && previous.width === image.width && previous.height === image.height) {
      for (let i = 0; i < image.data.length; i += 4) {
        const d = image.data;
        const p = previous.data;
        if (d[i] !== p[i] || d[i + 1] !== p[i + 1] || d[i + 2] !== p[i + 2]) changed.push(i >> 2);
      }
      if (!changed.length) {
        pending.options.delay += frame.ms;
        continue;
      }
    }
    flush();
    if (!previous || changed.length === 0) {
      const palette = quantize(image.data, 256);
      pending = { index: applyPalette(image.data, palette), width: image.width, height: image.height, options: { palette, delay: frame.ms, dispose: 1 } };
    } else {
      const pixels = new Uint8Array(changed.length * 4);
      changed.forEach((p, n) => pixels.set(image.data.subarray(p * 4, p * 4 + 4), n * 4));
      const palette = quantize(pixels, 255);
      const colours = applyPalette(pixels, palette);
      const transparentIndex = palette.length;
      const index = new Uint8Array(image.width * image.height).fill(transparentIndex);
      changed.forEach((p, n) => (index[p] = colours[n]));
      pending = {
        index,
        width: image.width,
        height: image.height,
        options: { palette: [...palette, [0, 0, 0]], delay: frame.ms, dispose: 1, transparent: true, transparentIndex },
      };
    }
    previous = image;
  }
  flush();
  gif.finish();
  const bytes = Buffer.from(gif.bytes());
  return name ? tagGif(bytes, name) : bytes;
}

/**
 * How far apart the frames are while the pointer moves: the gaps (ms) between frames (`ats`, ms from the start) inside
 * the moves (`moves`, [from, to] in ms), as their median and 90th percentile. Undefined when no move has two frames.
 */
export function gapStats(ats, moves) {
  const gaps = moves.flatMap(([from, to]) => {
    const inside = ats.filter((at) => at >= from && at <= to).sort((a, b) => a - b);
    return inside.slice(1).map((at, n) => at - inside[n]);
  });
  if (!gaps.length) return undefined;
  gaps.sort((a, b) => a - b);
  const at = (p) => gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))];
  return { median: at(0.5), p90: at(0.9), count: gaps.length };
}
