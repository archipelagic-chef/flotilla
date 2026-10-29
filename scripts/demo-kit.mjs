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
export const ACTIONS = ['command', 'click', 'hover', 'drag', 'type', 'press', 'waitFor', 'wait', 'caption', 'highlight', 'agentTurn', 'gitHubComment'];
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
    // A drag names where it drops: { "drag": "<what>", "to": "<onto what>" }.
    const unknown = Object.keys(step).filter((k) => !ACTIONS.includes(k) && k !== 'timeout' && !(k === 'to' && 'drag' in step));
    if (unknown.length) throw new Error(`${where}: unknown ${unknown.join(', ')} (a step is one of ${ACTIONS.join(', ')})`);
    if (actions.length !== 1) throw new Error(`${where}: a step does one thing: ${ACTIONS.join(', ')}`);
    const action = actions[0];
    const value = step[action];
    if (
      action === 'wait'
        ? !(Number.isFinite(value) && value >= 0)
        : typeof value !== 'string' || (action !== 'caption' && action !== 'highlight' && !value.trim())
    ) {
      throw new Error(`${where}: "${action}" takes ${action === 'wait' ? 'a number of milliseconds' : 'a string'}`);
    }
    if (step.timeout !== undefined && !(Number.isFinite(step.timeout) && step.timeout > 0)) throw new Error(`${where}: "timeout" is a number of milliseconds`);
    if (action === 'drag' && (typeof step.to !== 'string' || !step.to.trim())) throw new Error(`${where}: "drag" drops "to" a selector`);
    return { action, value, ...(action === 'drag' ? { to: step.to } : {}), ...(step.timeout ? { timeout: step.timeout } : {}) };
  });
  // Flotilla's settings the demo plays with (say, the local checks on Merge to main): only Flotilla's own.
  const settings = demo.settings ?? {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`${name}: "settings" is an object of Flotilla's settings`);
  const other = Object.keys(settings).filter((k) => !/^flotilla\.[\w.]+$/.test(k) || k.startsWith('flotilla.dev.'));
  if (other.length) throw new Error(`${name}: "settings" takes only Flotilla's settings (flotilla.*, not flotilla.dev.*), not ${other.join(', ')}`);
  // The fake GitHub starts a CI run when a branch is pushed (BL-222), for a demo that pushes one.
  if (demo.runsOnPush !== undefined && typeof demo.runsOnPush !== 'boolean') throw new Error(`${name}: "runsOnPush" is true or false`);
  // The fake GitHub starts signed out (BL-245), for a demo of the sign-in prompts.
  if (demo.githubSignedOut !== undefined && typeof demo.githubSignedOut !== 'boolean') throw new Error(`${name}: "githubSignedOut" is true or false`);
  return {
    title: typeof demo.title === 'string' ? demo.title : name,
    steps,
    settings,
    runsOnPush: demo.runsOnPush === true,
    githubSignedOut: demo.githubSignedOut === true,
  };
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
 *
 * A frame shows at most STILL_MS (BL-219): a recording doesn't sit on a screen that waits. One with a caption on screen
 * (`captions`: when each was shown, `at`, with its text's `length`, 0 when removed) shows long enough to read it:
 * CAPTION_MS_PER_CHAR a character, at least CAPTION_MIN_MS. The first frame drawn after a highlight was shown
 * (`highlights`: when each was, `at`) shows at least HIGHLIGHT_MS (BL-246), long enough to see where it points. Each
 * frame's `at` stays when it was drawn; `cutMs` is how much of its time was cut.
 */
export function timeline(captures, endMs, { captions = [], highlights = [] } = {}) {
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
  const shownCaptions = [...captions].sort((a, b) => a.at - b.at);
  // Each highlight's frame: the first drawn once it was shown (or in the same FRAME_MS).
  const highlighted = new Set(highlights.map((h) => merged.findIndex((f) => f.at >= h.at - FRAME_MS)).filter((n) => n >= 0));
  return merged.map(({ png, at }, n) => {
    const to = n + 1 < merged.length ? merged[n + 1].at : Math.max(endMs, at);
    const cap = stillCap(shownCaptions, at, to);
    const capped = Math.min(to - at, highlighted.has(n) ? Math.max(cap, HIGHLIGHT_MS) : cap);
    // GIF delays are in hundredths of a second: at least 2 (most viewers slow down faster frames anyway).
    const ms = Math.max(20, Math.round(capped / 10) * 10);
    return { png, at, ms, cutMs: Math.max(0, Math.round((to - at - capped) / 10) * 10) };
  });
}

/** The longest a frame shows (ms) when nothing on it changes (BL-219). */
export const STILL_MS = 1200;
/** How long a frame with a caption shows at most: this long a character of the caption, and at least CAPTION_MIN_MS. */
export const CAPTION_MS_PER_CHAR = 60;
export const CAPTION_MIN_MS = 2000;
/** How long the frame that shows a new highlight shows at most (BL-246). */
export const HIGHLIGHT_MS = 2000;

/** The cap of a frame shown from `from` to `to`: STILL_MS, or longer for the longest caption on screen meanwhile. */
function stillCap(captions, from, to) {
  let length = 0;
  for (const [n, c] of captions.entries()) {
    const until = n + 1 < captions.length ? captions[n + 1].at : Infinity;
    // On screen for more than a FRAME_MS of it: one shown just as the next frame is drawn is that frame's.
    if (c.at < to - FRAME_MS && until > from + FRAME_MS) length = Math.max(length, c.length);
  }
  return length ? Math.max(STILL_MS, CAPTION_MIN_MS, length * CAPTION_MS_PER_CHAR) : STILL_MS;
}

/** How long the recording of `frames` (from timeline) is, and how much of the stills was cut (ms). */
export function recordingLength(frames) {
  return { ms: frames.reduce((sum, f) => sum + f.ms, 0), cutMs: frames.reduce((sum, f) => sum + (f.cutMs ?? 0), 0) };
}

/** "12.4 s, 9.1 s of stills cut": what the recorder says of a recording's length. */
export function lengthLine({ ms, cutMs }) {
  const s = (v) => `${(v / 1000).toFixed(1)} s`;
  return cutMs ? `${s(ms)}, ${s(cutMs)} of stills cut` : s(ms);
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

/**
 * A settings file's object, read as VS Code reads it: JSON with comments and trailing commas. Undefined when it's not
 * that, or not an object.
 */
export function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const from = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(from, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      out += ' ';
    } else if (c === ',' && /^\s*(\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*[}\]]/.test(text.slice(i + 1))) {
      // A trailing comma (outside strings: those are copied whole above).
    } else out += c;
  }
  try {
    const parsed = JSON.parse(out);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The files a demo plays from the build. */
export const BUILT = ['extension.js', 'webview.js', 'ticket.js'].map((f) => path.join('dist', f));

/**
 * Why the build is behind the sources (a file of dist/ missing, or one in src/ changed since), so the recorder builds
 * first: an old build plays an old sidebar, whose elements the demo's steps may not find. Undefined when it's current.
 */
export function staleBuild(root) {
  const missing = BUILT.find((f) => !fs.existsSync(path.join(root, f)));
  if (missing) return `${missing} is missing`;
  const builtAt = Math.min(...BUILT.map((f) => fs.statSync(path.join(root, f)).mtimeMs));
  const src = path.join(root, 'src');
  const changed = fs.readdirSync(src, { recursive: true }).find((f) => fs.statSync(path.join(src, f)).mtimeMs > builtAt);
  return changed ? `src/${changed} changed since the last build` : undefined;
}

/**
 * Why a step failed, in a line: Playwright's own errors when the window went away (a crash, or VS Code closing) say
 * so, since theirs ("reading '_object'", "Target closed") don't.
 */
export function failureReason(error) {
  const message = String(error?.message ?? error).split('\n')[0];
  if (/reading '_object'|Target crashed|Target page, context or browser has been closed|Target closed/.test(message)) {
    return `the VS Code window closed or crashed (${message})`;
  }
  return message;
}

/** The words a selector looks for: its quoted texts, classes, ids and attribute values, lowercased. */
function selectorWords(selector) {
  return [
    ...new Set(
      selector
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 1 && !['has', 'text', 'aria', 'label', 'nth', 'not', 'button', 'div', 'span', 'input'].includes(w)),
    ),
  ];
}

/**
 * The visible elements (`{ tag, text, label, classes }`) most like what a selector looks for, best first, as lines to
 * print when a step can't find it: those sharing the most of its words (or their starts), else the first ones.
 */
export function nearestElements(selector, elements, count = 8) {
  const words = selectorWords(selector);
  const scored = elements.map((element) => {
    const hay = [element.label, element.text, element.classes].filter(Boolean).join(' ').toLowerCase();
    // A word found whole counts most; its start (a typo, a plural) still counts.
    return {
      element,
      score: words.reduce((sum, w) => sum + (hay.includes(w) ? 2 : w.length > 4 && hay.includes(w.slice(0, Math.max(4, w.length - 2))) ? 1 : 0), 0),
    };
  });
  const matching = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  const picked = (matching.length ? matching : scored.filter((s) => s.element.label || s.element.text)).slice(0, count);
  return picked.map(({ element: { tag, text, label, classes } }) => {
    const parts = [tag + (classes ? `.${classes.trim().split(/\s+/).slice(0, 3).join('.')}` : '')];
    if (label) parts.push(`aria-label="${label}"`);
    if (text && text !== label) parts.push(JSON.stringify(text.length > 60 ? `${text.slice(0, 57)}…` : text));
    return parts.join(' ');
  });
}

/** A size in bytes, as "512 KB" or "1.4 MB". */
function size(bytes) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The recorder's last line, for an agent to read: `{ saved, bytes, ms }` when it was recorded, `{ checked, ms }` when
 * a check passed every step, or `{ step, reason, screenshot }` when it failed.
 */
export function resultLine(result) {
  if (result.saved) return `Demo saved: ${result.saved} (${size(result.bytes)}, ${lengthLine({ ms: result.ms, cutMs: result.cutMs ?? 0 })})`;
  if (result.checked !== undefined) return `Demo checked: all ${result.checked} steps passed (${(result.ms / 1000).toFixed(1)} s). Record it once now.`;
  const at = result.step ? `${result.step}: ` : '';
  return `Demo failed: ${at}${result.reason}${result.screenshot ? ` (screenshot: ${result.screenshot})` : ''}`;
}

/**
 * Makes the demo profile's settings file plain JSON, as the profile's writer reads it: one with comments or trailing
 * commas is rewritten without them (`rewritten`), one that isn't even that is moved aside to `<file>.broken` and the
 * profile starts afresh (`moved`: the demo profile is the recorder's own, never the user's). `kept` when it was plain.
 */
export function plainSettings(file) {
  if (!fs.existsSync(file)) return 'kept';
  const text = fs.readFileSync(file, 'utf8');
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return 'kept';
  } catch {
    // Read as JSON with comments below.
  }
  const settings = parseJsonc(text);
  if (settings) {
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
    return 'rewritten';
  }
  fs.renameSync(file, `${file}.broken`);
  return 'moved';
}

/** Whether the command palette's row (its aria-label) is the command a step typed: it has every word typed. */
export function commandMatches(typed, label) {
  if (!label) return false;
  const words = label.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return String(typed)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .every((w) => words.includes(w));
}
