// Demos (BL-78): a short script of steps (demos/<name>.json) that shows a change working, played in an isolated
// VS Code window, recorded as a GIF (or an MP4 when it's long: ffmpeg from PATH or @ffmpeg-installer/ffmpeg), and
// played again live for the ticket's Run button (a `run demo <name>` block).
//
//   npm run demo -- record <name> --out <file.gif>   records it (agents put it next to the ticket: <backlog>/<id>/demo.gif)
//        [--still <file.png>]                        and saves its last frame, to check how it ends
//   npm run demo -- check <name>                     plays its steps fast, without recording: the dry run before one
//   npm run demo -- play <name>                      plays it in the window, live, and leaves the window open
//   npm run demo -- list                             the demos there are
//
// Before it starts, it builds when dist/ is behind src/ and makes the demo profile's settings plain JSON. A step that
// fails saves a screenshot next to the demo (demos/<name>.failed.png) and prints the visible elements most like what it
// looked for. Its last line says how it went: "Demo saved: …", "Demo checked: …" or "Demo failed: …".
//
// The window is never the user's: it's VS Code's test download (.vscode-test, as npm run test:vscode uses), with a profile
// of its own (.vscode-test/demo-profile: no accounts, no secrets), the fake Claude and a fake GitHub started here, and it
// opens on this worktree's .playground. Frames are that window's page as Chromium draws it (its screencast, through its
// debugging port), never the screen, and each is kept only once a check after it found that window: if one doesn't,
// nothing is saved.
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXTENSIONS_DIR,
  extensionFolders,
  findClaudeCode,
  installClaudeCode,
  writeProfileSettings,
} from './debug-profile.mjs';
import { mainRoot, withDownloadLock, withLock } from './vscode-download.mjs';
import { recordEvent, ticketOfBranch } from './record-event.mjs';
import {
  DEMOS_DIR,
  DEMO_TAG,
  GIF_MAX_MS,
  TITLE_MARKER,
  demoDisplay,
  commandMatches,
  demoFile,
  failureReason,
  frameGate,
  freeDisplay,
  encodeGif,
  gapStats,
  listDemos,
  nearestElements,
  parseDemo,
  plainSettings,
  resultLine,
  staleBuild,
  stepsToPlay,
  timeline,
  unsafeFrame,
} from './demo-kit.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PROFILE_DIR = path.join(root, '.vscode-test', 'demo-profile');
/**
 * The window's home folder: VS Code keeps some state there for every profile (~/.vscode-shared), and git and the
 * extensions read the user's config and keys from it. Empty here, so the window sees none of the user's.
 */
const HOME_DIR = path.join(root, '.vscode-test', 'demo-home');
/** Claude Code's folder in that home: the playground's chats are seeded there (seedChats), so demos can open them. */
const CLAUDE_DIR = path.join(HOME_DIR, '.claude');
const PLAYGROUND = path.join(root, '.playground');
/**
 * Held while a demo runs: a second VS Code on the same profile would hand itself to the first one's window and close.
 * Demos in other worktrees have profiles of their own.
 */
const LOCK_FILE = `${PROFILE_DIR}.lock`;
const WIDTH = 1280;
const HEIGHT = 800;
/** The repository's git dir and branch here, for the demo's event; undefined outside a repository. */
function gitCommonDir() {
  try {
    return path.resolve(execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    return undefined;
  }
}
function gitBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

/** How often the window is checked to be the demo window while recording (each check covers the frames before it). */
const CHECK_MS = 250;
/** The window is ready once nothing has changed on screen for this long (ms), and waited for at most READY_MS. */
const QUIET_MS = 1000;
const READY_MS = 60_000;
/** The pause after each step, and how long the pointer takes to move: slow enough to follow, live and in the GIF. */
const PACE_MS = 700;
const MOVE_MS = 450;
const TIMEOUT_MS = 15_000;

/** The settings the demo window starts with: quiet (no tips, updates or AI offers), trusted, and its title marked. */
const DEMO_SETTINGS = {
  'window.title': `${TITLE_MARKER} · \${rootName}\${separator}\${activeEditorShort}`,
  'window.restoreWindows': 'none',
  'window.commandCenter': false,
  // A modal (a confirmation) drawn in the page, not by the OS: frames show it and steps can click it.
  'window.dialogStyle': 'custom',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.enableExperiments': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'chat.disableAIFeatures': true,
  'security.workspace.trust.enabled': false,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoCheckUpdates': false,
  'extensions.autoUpdate': false,
  'extensions.ignoreRecommendations': true,
  'git.openRepositoryInParentFolders': 'never',
};

/** The Flotilla settings the last demo set (its "settings"), taken out before the next one sets its own. */
const DEMO_OWN_FILE = path.join(PROFILE_DIR, 'demo-settings.json');

/** The demo profile, made ready: Claude Code copied in, the fakes on (pointing at `githubUrl`), the demo's settings. */
function prepareProfile(githubUrl, own = {}) {
  installClaudeCode(findClaudeCode(extensionFolders())?.path, path.join(root, EXTENSIONS_DIR));
  const file = path.join(PROFILE_DIR, 'User', 'settings.json');
  // Settings with comments (VS Code writes them so) read as they are; a broken file is set aside and started afresh.
  if (plainSettings(file) === 'moved')
    console.log(`The demo profile's settings.json wasn't JSON: moved to ${path.relative(root, file)}.broken, and started afresh.`);
  const result = writeProfileSettings(PROFILE_DIR, { root, fakes: true });
  if (result.unreadable) throw new Error(`${file} isn't JSON: delete .vscode-test/demo-profile and try again`);
  if (!result.applied.includes('fake Claude') || !result.applied.includes('fake GitHub')) {
    throw new Error(`the fakes aren't in this worktree (${path.join(root, 'scripts', 'fake-claude.mjs')}, ${path.join(root, 'scripts', 'fake-github.mjs')})`);
  }
  const settings = { ...JSON.parse(fs.readFileSync(file, 'utf8')), ...DEMO_SETTINGS, 'flotilla.dev.githubApi': githubUrl };
  let last = [];
  try {
    last = JSON.parse(fs.readFileSync(DEMO_OWN_FILE, 'utf8'));
  } catch {
    // None yet (or unreadable): no settings of the last demo's to take out.
  }
  for (const key of Array.isArray(last) ? last : []) delete settings[key];
  Object.assign(settings, own);
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  fs.writeFileSync(DEMO_OWN_FILE, `${JSON.stringify(Object.keys(own))}\n`);
  // What the last demo left in the playground's window (the sidebar's state: a fold open, a filter on; the editors and
  // views open) goes: each demo starts from the same window, so a toggle it clicks toggles the same way every time.
  fs.rmSync(path.join(PROFILE_DIR, 'User', 'workspaceStorage'), { recursive: true, force: true });
}

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: npm run demo -- record <name> --out <file.gif> | check <name> | play <name> | try <name> | list');
  process.exit(1);
}

/** A check (`npm run demo -- check`): the steps without their pauses, pointer moves and typing delays. */
const pace = { fast: false };

/** When the recording started (Date.now()), and the pointer's moves since then ([from, to] in ms): to measure them. */
const recorded = { start: 0, moves: [] };

/** A pointer drawn over the workbench, so a viewer sees where each click goes (screenshots have no mouse). */
async function pointer(page, x, y) {
  if (pace.fast) return;
  const from = Date.now() - recorded.start;
  await page.evaluate(
    ({ x, y, ms }) => {
      let dot = document.getElementById('flotilla-demo-pointer');
      if (!dot) {
        dot = document.createElement('div');
        dot.id = 'flotilla-demo-pointer';
        Object.assign(dot.style, {
          position: 'fixed',
          left: '0',
          top: '0',
          width: '22px',
          height: '22px',
          margin: '-11px 0 0 -11px',
          borderRadius: '50%',
          background: 'rgba(255, 196, 0, 0.55)',
          border: '2px solid rgba(255, 255, 255, 0.9)',
          boxShadow: '0 0 6px rgba(0,0,0,0.6)',
          zIndex: '2147483647',
          pointerEvents: 'none',
          transition: `transform ${ms}ms ease-in-out`,
          transform: `translate(${innerWidth / 2}px, ${innerHeight / 2}px)`,
        });
        document.body.appendChild(dot);
        void dot.offsetWidth;
      }
      dot.style.transform = `translate(${x}px, ${y}px)`;
    },
    { x, y, ms: MOVE_MS },
  );
  recorded.moves.push([from, from + MOVE_MS]);
  await page.waitForTimeout(MOVE_MS + 50);
}

/** A caption at the bottom of the window (an empty one removes it). */
async function caption(page, text) {
  await page.evaluate((text) => {
    let box = document.getElementById('flotilla-demo-caption');
    if (!text) return box?.remove();
    if (!box) {
      box = document.createElement('div');
      box.id = 'flotilla-demo-caption';
      Object.assign(box.style, {
        position: 'fixed',
        left: '50%',
        bottom: '48px',
        transform: 'translateX(-50%)',
        maxWidth: '80%',
        padding: '10px 18px',
        borderRadius: '8px',
        background: 'rgba(20, 20, 20, 0.85)',
        color: '#fff',
        font: '600 18px system-ui, sans-serif',
        zIndex: '2147483646',
        pointerEvents: 'none',
        textAlign: 'center',
      });
      document.body.appendChild(box);
    }
    box.textContent = text;
  }, text);
}

/** The first visible element a selector finds, in the workbench or any webview inside it. */
async function find(page, selector, timeout) {
  const end = Date.now() + timeout;
  for (;;) {
    for (const frame of page.frames()) {
      const locator = frame.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let n = 0; n < count; n++) {
        const one = locator.nth(n);
        if (await one.isVisible().catch(() => false)) return one;
      }
    }
    if (Date.now() > end) throw new Error(`nothing visible matches ${selector} after ${timeout} ms`);
    await page.waitForTimeout(150);
  }
}

/**
 * The window's frames as Chromium draws them (BL-133): its screencast pushes a PNG whenever the page changes, each with
 * the time it was drawn, on a session of its own, so capturing neither waits on nor slows the demo's steps. At most
 * every frame: the timeline keeps 25 a second. Resolves to a function that stops it.
 */
async function screencast(page, onFrame) {
  const cdp = await page.context().newCDPSession(page);
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    // The next frame comes only once this one is acknowledged.
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
    const now = Date.now();
    // When it was drawn (seconds since the epoch); the time it came, when that's missing or from another clock.
    const drawn = metadata.timestamp * 1000;
    onFrame({ time: Math.abs(drawn - now) < 5000 ? drawn : now, png: Buffer.from(data, 'base64') });
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  return async () => {
    await cdp.send('Page.stopScreencast').catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  };
}

/**
 * The visible elements of the workbench and its webviews (`{ tag, text, label, classes }`): those a step may look for
 * (labelled, clickable, list items, headings), to print the ones nearest a selector that found nothing.
 */
async function visibleElements(page) {
  const all = [];
  for (const frame of page.frames()) {
    const found = await frame
      .evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('[aria-label], [title], button, a, input, textarea, select, [role], h1, h2, h3, li')) {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
          // A container's text is all of its children's: only an element's own short text says what it is.
          const all = (el.innerText ?? el.value ?? '').trim().replace(/\s+/g, ' ');
          const text = all.length <= 100 ? all : '';
          const label = el.getAttribute('aria-label') ?? el.getAttribute('title') ?? undefined;
          if (!text && !label) continue;
          out.push({
            tag: el.tagName.toLowerCase(),
            text: text || undefined,
            label: label || undefined,
            classes: typeof el.className === 'string' ? el.className : undefined,
          });
          if (out.length >= 600) break;
        }
        return out;
      })
      .catch(() => []);
    all.push(...found);
  }
  return all;
}

/**
 * Waits until the window is ready for the demo: the workbench shown, Flotilla's view in the activity bar, Flotilla's
 * status bar item (shown once the extension has started, so its commands are there), and nothing changed on screen (`drawnAt`: when the last frame came) for QUIET_MS, as extensions and the
 * first git scan settle. A window that never settles fails the demo, rather than recording one still loading.
 */
async function ready(page, drawnAt) {
  const end = Date.now() + READY_MS;
  await page.locator('.monaco-workbench').waitFor({ timeout: READY_MS });
  await page
    .locator('.activitybar [aria-label^="Flotilla"]')
    .first()
    .waitFor({ timeout: Math.max(1000, end - Date.now()) });
  // The activity bar's icon is there before the extension starts; its status bar item only once it has.
  await page
    .locator('.statusbar-item[id$="flotilla.current"]')
    .first()
    .waitFor({ timeout: Math.max(1000, end - Date.now()) })
    .catch(() => {
      throw new Error(`Flotilla didn't start in the window (no status bar item after ${READY_MS / 1000} s)`);
    });
  while (Date.now() - drawnAt() < QUIET_MS) {
    if (Date.now() > end) throw new Error(`the window didn't settle (its screen still changing after ${READY_MS / 1000} s)`);
    await page.waitForTimeout(100);
  }
}

/** Plays a step in the window. */
async function play(page, step) {
  const timeout = step.timeout ?? TIMEOUT_MS;
  switch (step.action) {
    case 'command': {
      await page.keyboard.press('F1');
      const input = page.locator('.quick-input-widget input');
      await input.waitFor({ state: 'visible', timeout });
      await input.pressSequentially(step.value, { delay: pace.fast ? 0 : 35 });
      await page.waitForTimeout(pace.fast ? 150 : 400);
      // With no match, the palette offers "similar commands", and Enter would run one: the next step then fails far
      // from why. Say so here.
      const row = page.locator('.quick-input-widget .quick-input-list .monaco-list-row.focused').first();
      const label = await row.getAttribute('aria-label', { timeout: 2000 }).catch(() => undefined);
      if (!commandMatches(step.value, label)) {
        throw new Error(`no command "${step.value}" in the command palette (${label ? `it offers "${label.split(',')[0]}"` : 'it lists none'})`);
      }
      await page.keyboard.press('Enter');
      break;
    }
    case 'click': {
      const target = await find(page, step.value, timeout);
      const box = await target.boundingBox();
      if (box) await pointer(page, box.x + box.width / 2, box.y + box.height / 2);
      await target.click({ timeout });
      break;
    }
    case 'hover': {
      const target = await find(page, step.value, timeout);
      const box = await target.boundingBox();
      if (box) await pointer(page, box.x + box.width / 2, box.y + box.height / 2);
      await target.hover({ timeout });
      break;
    }
    case 'drag': {
      const source = await find(page, step.value, timeout);
      const target = await find(page, step.to, timeout);
      const from = await source.boundingBox();
      const to = await target.boundingBox();
      if (from) await pointer(page, from.x + from.width / 2, from.y + from.height / 2);
      if (to) await pointer(page, to.x + to.width / 2, to.y + to.height / 2);
      await source.dragTo(target, { timeout });
      break;
    }
    case 'type':
      await page.keyboard.type(step.value, { delay: pace.fast ? 0 : 45 });
      break;
    case 'press':
      await page.keyboard.press(step.value);
      break;
    case 'waitFor':
      await find(page, step.value, timeout);
      break;
    case 'wait':
      await page.waitForTimeout(step.value);
      return;
    case 'caption':
      await caption(page, step.value);
      break;
    case 'agentTurn': {
      // The seeded agent's chat goes on by a turn, as a running agent's would (its transcript grows).
      const { appendAgentTurn } = await import('./playground-seed.mjs');
      if (!appendAgentTurn(PLAYGROUND, CLAUDE_DIR)) throw new Error(`the agent's chat (${step.value}) has no turn left`);
      break;
    }
  }
  await page.waitForTimeout(pace.fast ? 100 : PACE_MS);
}

/**
 * The ffmpeg to make an MP4 of a long demo with: the one on PATH, else the one @ffmpeg-installer/ffmpeg brings (a dev
 * dependency, so no system install is needed); undefined when neither runs.
 */
function findFfmpeg() {
  const candidates = ['ffmpeg'];
  try {
    candidates.push(createRequire(import.meta.url)('@ffmpeg-installer/ffmpeg').path);
  } catch {
    // Not installed, or no build for this platform.
  }
  return candidates.find((bin) => {
    try {
      execFileSync(bin, ['-version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Writes the recording: a GIF, or an MP4 (next to it, same name) when it's longer than GIF_MAX_MS and there's an ffmpeg.
 * Either names its demo in its comment (DEMO_TAG), for the ticket's Try it yourself (BL-111).
 */
function save(captures, endMs, out, name) {
  const frames = timeline(captures, endMs);
  const ffmpeg = endMs > GIF_MAX_MS ? findFfmpeg() : undefined;
  if (ffmpeg) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flotilla-demo-'));
    try {
      const list = frames.map((f, n) => {
        fs.writeFileSync(path.join(dir, `${n}.png`), f.png);
        return `file '${n}.png'\nduration ${f.ms / 1000}`;
      });
      // The concat demuxer takes the last frame's duration only when the frame is listed again.
      list.push(`file '${frames.length - 1}.png'`);
      fs.writeFileSync(path.join(dir, 'frames.txt'), `${list.join('\n')}\n`);
      const mp4 = out.replace(/\.[^./\\]+$/, '') + '.mp4';
      execFileSync(
        ffmpeg,
        [
          '-y',
          '-loglevel',
          'error',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          'frames.txt',
          '-vf',
          'scale=trunc(min(iw\\,1280)/2)*2:-2,fps=25',
          '-pix_fmt',
          'yuv420p',
          '-c:v',
          'libx264',
          '-metadata',
          `comment=${DEMO_TAG}${name}`,
          path.resolve(mp4),
        ],
        { cwd: dir, stdio: 'inherit' },
      );
      return { file: mp4, note: '' };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(out, encodeGif(frames, { name }));
  const note =
    endMs > GIF_MAX_MS
      ? ` It's longer than ${GIF_MAX_MS / 1000} s, so it would be an MP4, but there's no ffmpeg (not on PATH, and @ffmpeg-installer/ffmpeg isn't installed: run npm install): it's a GIF.`
      : '';
  return { file: out, note };
}

async function main() {
  const [mode, name, ...rest] = process.argv.slice(2);
  if (mode === 'list') {
    const names = listDemos(root);
    console.log(names.length ? names.join('\n') : `No demos yet: they're ${path.join('demos', '<name>.json')}.`);
    return;
  }
  if (mode !== 'record' && mode !== 'play' && mode !== 'try' && mode !== 'check') usage();
  pace.fast = mode === 'check';
  const file = demoFile(root, name);
  if (!fs.existsSync(file)) usage(`There's no demo "${name}" (${path.relative(root, file)}). The demos: ${listDemos(root).join(', ') || 'none'}.`);
  const demo = { ...parseDemo(fs.readFileSync(file, 'utf8'), name), name };
  const outAt = rest.indexOf('--out');
  const out = outAt >= 0 ? rest[outAt + 1] : undefined;
  const stillAt = rest.indexOf('--still');
  const still = stillAt >= 0 ? rest[stillAt + 1] : undefined;
  if (mode === 'record' && (!out || !/\.gif$/i.test(out))) usage('record needs --out <file.gif> (a long demo becomes <file>.mp4)');

  // A lock left by a demo that's gone is taken over; one held open (a demo played, its window not closed yet) isn't.
  const display = demoDisplay(process.env);
  await withLock(LOCK_FILE, () => (build(), show(mode, demo, out, still, display)), {
    staleMs: Number.POSITIVE_INFINITY,
    onWait: () => console.log('Another demo is running in this worktree: waiting for it to finish (or close its window)…'),
  });
}

/** Builds when dist/ is behind src/ (staleBuild), under the demo's lock, so two demos here don't build at once. */
function build() {
  const stale = staleBuild(root);
  if (!stale) return;
  console.log(`Building first (${stale})…`);
  try {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '-s', 'build'], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: process.platform === 'win32',
    });
  } catch {
    throw new Error('the build failed (npm run build): fix it and try again');
  }
}

/**
 * A virtual display (Xvfb) for the demo window, so that it never opens on the user's screen: on the first number from
 * :99 up that has neither a socket nor a lock (freeDisplay), the next one when another demo's Xvfb took it meanwhile.
 * Larger than the window, which is sized to WIDTH x HEIGHT on it, at 24-bit colour: frames are the same as on a real
 * display. Fails, rather than falling back to the screen, when Xvfb isn't there.
 */
async function startXvfb() {
  let from = 99;
  for (let attempt = 1; ; attempt++) {
    const n = freeDisplay(fs.existsSync, from);
    try {
      return await startXvfbOn(n);
    } catch (error) {
      if (error.missing || attempt === 5) throw error;
      from = n + 1;
    }
  }
}

/** Xvfb on display `:n`, once it's ready for clients. */
function startXvfbOn(n) {
  return new Promise((resolve, reject) => {
    const xvfb = spawn('Xvfb', [`:${n}`, '-displayfd', '3', '-screen', '0', `${WIDTH + 640}x${HEIGHT + 400}x24`, '-nolisten', 'tcp'], {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
    });
    let ready = '';
    let stderr = '';
    xvfb.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    xvfb.on('error', (error) => {
      if (error.code !== 'ENOENT') return reject(new Error(`Xvfb didn't start: ${error.message}`));
      reject(
        Object.assign(
          new Error("Xvfb isn't installed, and a demo an agent runs opens on a virtual display, never on the user's screen: install it (apt-get install xvfb)"),
          { missing: true },
        ),
      );
    });
    xvfb.on('exit', (code) => reject(new Error(`Xvfb stopped on :${n} (${code}): ${stderr.trim().split('\n').pop() ?? ''}`)));
    // It writes the display's number to fd 3 once it's ready for clients.
    xvfb.stdio[3].on('data', (d) => {
      ready += d;
      if (ready.includes('\n')) resolve({ display: `:${n}`, stop: () => xvfb.kill() });
    });
  });
}

/** Plays (or records) `demo` in the demo window: only one at a time per worktree, as it holds the demo profile. */
async function show(mode, demo, out, still, display) {
  const playground = PLAYGROUND;
  // Made when missing, and brought up to date otherwise (its local origin, BL-113): it changes nothing else.
  execFileSync(process.execPath, [path.join(root, 'scripts', 'playground.mjs')], { cwd: root, stdio: 'inherit' });

  const { downloadAndUnzipVSCode } = await import('@vscode/test-electron');
  const { _electron } = await import('playwright-core');
  const { ACTION_DELAY_MS, startFakeGitHub } = await import('./fake-github.mjs');
  const github = await startFakeGitHub({ port: 0, repoDir: playground, actionDelayMs: ACTION_DELAY_MS });
  prepareProfile(github.url, demo.settings);
  fs.mkdirSync(HOME_DIR, { recursive: true });
  // Its chats, fresh: the agent's is working (BL-123).
  const { seedChats, seedCreating, seedEvents } = await import('./playground-seed.mjs');
  seedChats(playground, CLAUDE_DIR);
  seedCreating(playground);
  // A month of events up to now, for the Metrics view (BL-158).
  seedEvents(playground);
  const cachePath = path.join(mainRoot(root), '.vscode-test');
  const executable = await withDownloadLock(cachePath, () => downloadAndUnzipVSCode({ cachePath }));

  const xvfb = display === 'virtual' ? await startXvfb() : undefined;
  console.log(
    `${{ record: 'Recording', try: 'Setting up', check: 'Checking' }[mode] ?? 'Playing'} "${demo.title}" in an isolated VS Code (profile ${path.relative(root, PROFILE_DIR)}, on .playground${xvfb ? `, on virtual display ${xvfb.display}` : ''})…`,
  );
  const app = await _electron
    .launch({
      executablePath: executable,
      args: [
        `--extensionDevelopmentPath=${root}`,
        `--user-data-dir=${PROFILE_DIR}`,
        `--extensions-dir=${path.join(root, EXTENSIONS_DIR)}`,
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
        '--new-window',
        // /dev/shm is small in containers (64 MB): with another demo window open, the renderer crashed for want of it.
        '--disable-dev-shm-usage',
        // Secrets (the autopilot's key) in the profile, not the system keyring: a virtual display has none, and a read waited forever.
        '--password-store=basic',
        playground,
      ],
      // The user's VS Code session variables would make this window talk to theirs.
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([k]) => !k.startsWith('VSCODE_') && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'CLAUDE_CONFIG_DIR' && !(xvfb && k === 'WAYLAND_DISPLAY'),
          ),
        ),
        HOME: HOME_DIR,
        USERPROFILE: HOME_DIR,
        // On the virtual display (Wayland, dropped above, would put the window on the user's screen).
        ...(xvfb ? { DISPLAY: xvfb.display } : {}),
      },
      timeout: 60_000,
    })
    .catch((error) => {
      xvfb?.stop();
      throw error;
    });
  // Kept now: once the window is closed, app.process() no longer answers (it throws "reading '_object'").
  let child;
  try {
    child = app.process();
  } catch {
    // Closed already: the first thing done with it says so.
  }
  let failed;
  try {
    const argv = await app.evaluate(() => process.argv);
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows().forEach((win) => win.setContentSize(w, h)), [WIDTH, HEIGHT]);
    // Frames from the moment the window is there: the screen settling is what tells that it's ready.
    const gate = frameGate(async () => unsafeFrame({ title: await page.title().catch(() => undefined), argv }, { profileDir: PROFILE_DIR }));
    let drawnAt = Date.now();
    const stopScreencast = await screencast(page, (frame) => {
      drawnAt = Date.now();
      if (mode === 'record') gate.add(frame);
    });
    let recording = mode === 'record';
    let checking;
    let start;
    let end;
    try {
      await ready(page, () => drawnAt);
      // Every frame is kept only once a check after it found the demo window (frameGate), so one from anywhere else never
      // is. Checked from now on: the title is the demo window's once it's ready (the first check covers the frames before).
      checking = (async () => {
        while (recording && !(await gate.check())) await new Promise((r) => setTimeout(r, CHECK_MS));
      })();
      start = Date.now();
      recorded.start = start;
      // Try it yourself (BL-135): the window as the demo starts, its steps left to you.
      const steps = stepsToPlay(demo, mode);
      for (const [n, step] of steps.entries()) {
        if (gate.unsafe) break;
        const label = `step ${n + 1} (${step.action} ${JSON.stringify(step.value)}${step.to ? ` to ${JSON.stringify(step.to)}` : ''})`;
        const at = Date.now();
        try {
          await play(page, step);
        } catch (error) {
          throw await stepFailed(page, demo, n + 1, label, step, error);
        }
        if (mode === 'check') console.log(`  ok ${label} (${Date.now() - at} ms)`);
      }
      fs.rmSync(failedShot(demo), { force: true });
    } finally {
      end = Date.now();
      recording = false;
      await checking;
      await stopScreencast();
    }
    // The frames drawn up to the end, now that a last check covers them.
    if (mode === 'record') await gate.check();
    const unsafe = gate.unsafe;
    const captures = gate.kept.map(({ time, png }) => ({ at: time - start, png }));
    if (unsafe) throw new Error(`Not recorded: ${unsafe}. Nothing was saved.`);
    if (mode === 'record') {
      const endMs = end - start;
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      const gaps = gapStats(
        timeline(captures, endMs).map((f) => f.at),
        recorded.moves,
      );
      if (gaps)
        console.log(
          `While the pointer moved: frames ${Math.round(gaps.median)} ms apart (median), ${Math.round(gaps.p90)} ms (90th percentile), over ${gaps.count} gaps.`,
        );
      const saved = save(captures, endMs, out, demo.name);
      // For the metrics (BL-157, BL-133): how smooth the recording was.
      const commonDir = gitCommonDir();
      const data = {
        name: demo.name,
        frames: captures.length,
        ms: endMs,
        ...(gaps ? { medianGapMs: Math.round(gaps.median), p90GapMs: Math.round(gaps.p90) } : {}),
      };
      recordEvent(commonDir, 'demo-recorded', { ticket: ticketOfBranch(gitBranch()), data });
      if (saved.note) console.log(saved.note.trim());
      if (still && captures.length) {
        fs.writeFileSync(still, captures[captures.length - 1].png);
        console.log(`Its last frame: ${still}`);
      }
      console.log(resultLine({ saved: saved.file, bytes: fs.statSync(saved.file).size, ms: endMs }));
    } else if (mode === 'check') {
      recordEvent(gitCommonDir(), 'demo-checked', {
        ticket: ticketOfBranch(gitBranch()),
        data: { name: demo.name, steps: demo.steps.length, ms: end - start },
      });
      console.log(resultLine({ checked: demo.steps.length, ms: end - start }));
    } else if (xvfb) {
      console.log('Done. The window was on a virtual display, so it closes now.');
    } else if (mode === 'try') {
      console.log(`Ready: "${demo.title}" as it starts. Try it yourself; close the window when you are done.`);
      if (child) await new Promise((resolve) => child.once('exit', resolve));
    } else {
      console.log('Done. The window stays open to look around; close it when you are done.');
      if (child) await new Promise((resolve) => child.once('exit', resolve));
    }
  } catch (error) {
    failed = error;
  } finally {
    // VS Code may take a while to quit (or not at all, when something holds it): it's stopped after a few seconds.
    // Nothing here may hide the error a step ended with.
    await Promise.race([app.close().catch(() => undefined), new Promise((r) => setTimeout(r, 5000))]);
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await github.close().catch(() => undefined);
    xvfb?.stop();
  }
  if (failed) throw failed;
}

/** Where a demo's failed step leaves its screenshot: next to the demo (git ignores it), gone once a run passes. */
function failedShot(demo) {
  return path.join(root, DEMOS_DIR, `${demo.name}.failed.png`);
}

/**
 * The error a step failed with, made one to fix the demo by: why (failureReason), a screenshot of the window as it
 * was, and the visible elements most like what the step looked for.
 */
async function stepFailed(page, demo, number, label, step, error) {
  const reason = failureReason(error);
  const shot = failedShot(demo);
  const screenshot = await page.screenshot({ path: shot }).then(
    () => path.relative(process.cwd(), shot),
    () => undefined,
  );
  const selector = [step.value, step.to].filter((v) => typeof v === 'string').join(' ');
  if (['click', 'hover', 'drag', 'waitFor'].includes(step.action)) {
    const near = nearestElements(selector, await visibleElements(page));
    if (near.length) console.error(`On screen, nearest ${selector}:\n${near.map((line) => `  ${line}`).join('\n')}`);
  }
  return Object.assign(new Error(`${label}: ${reason}`), { step: label, number, reason, screenshot });
}

// Exits when done: connections the window left open (the fake GitHub's) would keep it running.
const [modeArg, nameArg] = process.argv.slice(2);
main().then(
  () => process.exit(0),
  (error) => {
    const reason = error.reason ?? failureReason(error);
    if (nameArg && modeArg !== 'list') {
      const data = { name: nameArg, mode: modeArg, ...(error.number ? { step: error.number } : {}), reason: reason.slice(0, 200) };
      recordEvent(gitCommonDir(), 'demo-failed', { ticket: ticketOfBranch(gitBranch()), data });
    }
    console.error(resultLine({ step: error.step, reason, screenshot: error.screenshot }));
    process.exit(1);
  },
);
