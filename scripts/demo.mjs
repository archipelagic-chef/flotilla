// Demos (BL-78): a short script of steps (demos/<name>.json) that shows a change working, played in an isolated
// VS Code window, recorded as a GIF (or an MP4 when it's long: ffmpeg from PATH or @ffmpeg-installer/ffmpeg), and
// played again live for the ticket's Run button (a `run demo <name>` block).
//
//   npm run demo -- record <name> --out <file.gif>   records it (agents put it next to the ticket: <backlog>/<id>/demo.gif)
//        [--still <file.png>]                        and saves its last frame, to check how it ends
//   npm run demo -- play <name>                      plays it in the window, live, and leaves the window open
//   npm run demo -- list                             the demos there are
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
import { EXTENSIONS_DIR, extensionFolders, findClaudeCode, installClaudeCode, writeProfileSettings } from './debug-profile.mjs';
import { mainRoot, withDownloadLock, withLock } from './vscode-download.mjs';
import { DEMO_TAG, GIF_MAX_MS, TITLE_MARKER, demoDisplay, demoFile, frameGate, freeDisplay, encodeGif, gapStats, listDemos, parseDemo, stepsToPlay, timeline, unsafeFrame } from './demo-kit.mjs';

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
  const result = writeProfileSettings(PROFILE_DIR, { root, fakes: true });
  if (result.unreadable) throw new Error(`${PROFILE_DIR}/User/settings.json isn't plain JSON: delete .vscode-test/demo-profile and try again`);
  if (!result.applied.includes('fake Claude') || !result.applied.includes('fake GitHub')) throw new Error('the fakes (scripts/fake-claude.mjs, scripts/fake-github.mjs) are missing');
  const file = path.join(PROFILE_DIR, 'User', 'settings.json');
  const settings = { ...JSON.parse(fs.readFileSync(file, 'utf8')), ...DEMO_SETTINGS, 'flotilla.dev.githubApi': githubUrl };
  const last = fs.existsSync(DEMO_OWN_FILE) ? JSON.parse(fs.readFileSync(DEMO_OWN_FILE, 'utf8')) : [];
  for (const key of Array.isArray(last) ? last : []) delete settings[key];
  Object.assign(settings, own);
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  fs.writeFileSync(DEMO_OWN_FILE, `${JSON.stringify(Object.keys(own))}\n`);
}

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: npm run demo -- record <name> --out <file.gif> | play <name> | try <name> | list');
  process.exit(1);
}

/** When the recording started (Date.now()), and the pointer's moves since then ([from, to] in ms): to measure them. */
const recorded = { start: 0, moves: [] };

/** A pointer drawn over the workbench, so a viewer sees where each click goes (screenshots have no mouse). */
async function pointer(page, x, y) {
  const from = Date.now() - recorded.start;
  await page.evaluate(
    ({ x, y, ms }) => {
      let dot = document.getElementById('flotilla-demo-pointer');
      if (!dot) {
        dot = document.createElement('div');
        dot.id = 'flotilla-demo-pointer';
        Object.assign(dot.style, {
          position: 'fixed', left: '0', top: '0', width: '22px', height: '22px', margin: '-11px 0 0 -11px', borderRadius: '50%',
          background: 'rgba(255, 196, 0, 0.55)', border: '2px solid rgba(255, 255, 255, 0.9)', boxShadow: '0 0 6px rgba(0,0,0,0.6)',
          zIndex: '2147483647', pointerEvents: 'none', transition: `transform ${ms}ms ease-in-out`, transform: `translate(${innerWidth / 2}px, ${innerHeight / 2}px)`,
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
        position: 'fixed', left: '50%', bottom: '48px', transform: 'translateX(-50%)', maxWidth: '80%', padding: '10px 18px',
        borderRadius: '8px', background: 'rgba(20, 20, 20, 0.85)', color: '#fff', font: '600 18px system-ui, sans-serif',
        zIndex: '2147483646', pointerEvents: 'none', textAlign: 'center',
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
 * Waits until the window is ready for the demo: the workbench shown, Flotilla's view in the activity bar (the extension
 * loaded), and nothing changed on screen (`drawnAt`: when the last frame came) for QUIET_MS, as extensions and the
 * first git scan settle. A window that never settles fails the demo, rather than recording one still loading.
 */
async function ready(page, drawnAt) {
  const end = Date.now() + READY_MS;
  await page.locator('.monaco-workbench').waitFor({ timeout: READY_MS });
  await page.locator('.activitybar [aria-label^="Flotilla"]').first().waitFor({ timeout: Math.max(1000, end - Date.now()) });
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
      await input.pressSequentially(step.value, { delay: 35 });
      await page.waitForTimeout(400);
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
    case 'type':
      await page.keyboard.type(step.value, { delay: 45 });
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
  await page.waitForTimeout(PACE_MS);
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
      execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'frames.txt', '-vf', 'scale=trunc(min(iw\\,1280)/2)*2:-2,fps=25', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-metadata', `comment=${DEMO_TAG}${name}`, path.resolve(mp4)], { cwd: dir, stdio: 'inherit' });
      return { file: mp4, note: '' };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(out, encodeGif(frames, { name }));
  const note = endMs > GIF_MAX_MS ? ` It's longer than ${GIF_MAX_MS / 1000} s, so it would be an MP4, but there's no ffmpeg (not on PATH, and @ffmpeg-installer/ffmpeg isn't installed: run npm install): it's a GIF.` : '';
  return { file: out, note };
}

async function main() {
  const [mode, name, ...rest] = process.argv.slice(2);
  if (mode === 'list') {
    const names = listDemos(root);
    console.log(names.length ? names.join('\n') : `No demos yet: they're ${path.join('demos', '<name>.json')}.`);
    return;
  }
  if (mode !== 'record' && mode !== 'play' && mode !== 'try') usage();
  const file = demoFile(root, name);
  if (!fs.existsSync(file)) usage(`There's no demo "${name}" (${path.relative(root, file)}). The demos: ${listDemos(root).join(', ') || 'none'}.`);
  const demo = { ...parseDemo(fs.readFileSync(file, 'utf8'), name), name };
  const outAt = rest.indexOf('--out');
  const out = outAt >= 0 ? rest[outAt + 1] : undefined;
  const stillAt = rest.indexOf('--still');
  const still = stillAt >= 0 ? rest[stillAt + 1] : undefined;
  if (mode === 'record' && (!out || !/\.gif$/i.test(out))) usage('record needs --out <file.gif> (a long demo becomes <file>.mp4)');

  const built = ['extension.js', 'webview.js', 'ticket.js'].map((f) => path.join(root, 'dist', f));
  if (!built.every((f) => fs.existsSync(f))) throw new Error('build first: npm run build');
  // An old build plays an old sidebar, whose elements the demo's steps may not find.
  const builtAt = Math.min(...built.map((f) => fs.statSync(f).mtimeMs));
  const changed = fs.readdirSync(path.join(root, 'src'), { recursive: true }).find((f) => fs.statSync(path.join(root, 'src', f)).mtimeMs > builtAt);
  if (changed) throw new Error(`build first: src/${changed} changed since the last build (npm run build)`);
  // A lock left by a demo that's gone is taken over; one held open (a demo played, its window not closed yet) isn't.
  const display = demoDisplay(process.env);
  await withLock(LOCK_FILE, () => show(mode, demo, out, still, display), {
    staleMs: Number.POSITIVE_INFINITY,
    onWait: () => console.log('Another demo is running in this worktree: waiting for it to finish (or close its window)…'),
  });
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
      reject(Object.assign(new Error("Xvfb isn't installed, and a demo an agent runs opens on a virtual display, never on the user's screen: install it (apt-get install xvfb)"), { missing: true }));
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
  const { startFakeGitHub } = await import('./fake-github.mjs');
  const github = await startFakeGitHub({ port: 0, repoDir: playground });
  prepareProfile(github.url, demo.settings);
  fs.mkdirSync(HOME_DIR, { recursive: true });
  // Its chats, fresh: the agent's is working (BL-123).
  const { seedChats } = await import('./playground-seed.mjs');
  seedChats(playground, CLAUDE_DIR);
  const cachePath = path.join(mainRoot(root), '.vscode-test');
  const executable = await withDownloadLock(cachePath, () => downloadAndUnzipVSCode({ cachePath }));

  const xvfb = display === 'virtual' ? await startXvfb() : undefined;
  console.log(
    `${mode === 'record' ? 'Recording' : mode === 'try' ? 'Setting up' : 'Playing'} "${demo.title}" in an isolated VS Code (profile ${path.relative(root, PROFILE_DIR)}, on .playground${xvfb ? `, on virtual display ${xvfb.display}` : ''})…`,
  );
  const app = await _electron.launch({
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
      playground,
    ],
    // The user's VS Code session variables would make this window talk to theirs.
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VSCODE_') && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'CLAUDE_CONFIG_DIR' && !(xvfb && k === 'WAYLAND_DISPLAY'))),
      HOME: HOME_DIR,
      USERPROFILE: HOME_DIR,
      // On the virtual display (Wayland, dropped above, would put the window on the user's screen).
      ...(xvfb ? { DISPLAY: xvfb.display } : {}),
    },
    timeout: 60_000,
  }).catch((error) => {
    xvfb?.stop();
    throw error;
  });
  // Kept now: once the window is closed, app.process() no longer answers.
  const child = app.process();
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
      for (const [n, step] of stepsToPlay(demo, mode).entries()) {
        if (gate.unsafe) break;
        try {
          await play(page, step);
        } catch (error) {
          throw new Error(`step ${n + 1} (${step.action} ${JSON.stringify(step.value)}): ${error.message.split('\n')[0]}`);
        }
      }
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
      const gaps = gapStats(timeline(captures, endMs).map((f) => f.at), recorded.moves);
      if (gaps) console.log(`While the pointer moved: frames ${Math.round(gaps.median)} ms apart (median), ${Math.round(gaps.p90)} ms (90th percentile), over ${gaps.count} gaps.`);
      const saved = save(captures, endMs, out, demo.name);
      console.log(`Saved ${saved.file} (${(endMs / 1000).toFixed(1)} s).${saved.note}`);
      if (still && captures.length) {
        fs.writeFileSync(still, captures[captures.length - 1].png);
        console.log(`Its last frame: ${still}`);
      }
    } else if (xvfb) {
      console.log('Done. The window was on a virtual display, so it closes now.');
    } else if (mode === 'try') {
      console.log(`Ready: "${demo.title}" as it starts. Try it yourself; close the window when you are done.`);
      await new Promise((resolve) => child.once('exit', resolve));
    } else {
      console.log('Done. The window stays open to look around; close it when you are done.');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  } catch (error) {
    failed = error;
  } finally {
    // VS Code may take a while to quit (or not at all, when something holds it): it's stopped after a few seconds.
    // Nothing here may hide the error a step ended with.
    await Promise.race([app.close().catch(() => undefined), new Promise((r) => setTimeout(r, 5000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await github.close().catch(() => undefined);
    xvfb?.stop();
  }
  if (failed) throw failed;
}

// Exits when done: connections the window left open (the fake GitHub's) would keep it running.
main().then(
  () => process.exit(0),
  (error) => {
    console.error(`Demo failed: ${error.message}`);
    process.exit(1);
  },
);
