import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DEMO_TAG as READ_TAG, gifSeconds, recordedDemo } from '../../../src/features/backlog/demo';
import { DEMO_TAG, FRAME_MS, commandMatches, decodePng, failureReason, nearestElements, parseJsonc, plainSettings, resultLine, staleBuild, demoDisplay, demoFile, frameGate, freeDisplay, downscale, encodeGif, gapStats, listDemos, parseDemo, stepsToPlay, timeline, unsafeFrame } from '../../../scripts/demo-kit.mjs';

/** A PNG chunk: length, type, body and CRC. */
function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])));
  return Buffer.concat([head, Buffer.from(type, 'latin1'), body, crc]);
}

/** A PNG of RGB or RGBA pixels, each row with its filter (the bytes are already filtered). */
function png(width: number, height: number, channels: 3 | 4, rows: { filter: number; bytes: number[] }[]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const raw = Buffer.from(rows.flatMap((r) => [r.filter, ...r.bytes]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A 2×2 PNG of one colour. */
function solid(r: number, g: number, b: number): Buffer {
  return png(2, 2, 3, [
    { filter: 0, bytes: [r, g, b, r, g, b] },
    { filter: 0, bytes: [r, g, b, r, g, b] },
  ]);
}

describe('parseDemo', () => {
  it('reads the steps, one action each, with their timeouts', () => {
    const demo = parseDemo(JSON.stringify({ title: 'T', steps: [{ command: 'Focus on Flotilla View' }, { click: 'text=BL-3', timeout: 5000 }, { hover: '.ci-run' }, { drag: 'text=BL-2', to: 'text=BL-1' }, { wait: 500 }, { caption: '' }] }));
    expect(demo).toEqual({
      title: 'T',
      steps: [
        { action: 'command', value: 'Focus on Flotilla View' },
        { action: 'click', value: 'text=BL-3', timeout: 5000 },
        { action: 'hover', value: '.ci-run' },
        { action: 'drag', value: 'text=BL-2', to: 'text=BL-1' },
        { action: 'wait', value: 500 },
        { action: 'caption', value: '' },
      ],
      settings: {},
    });
  });

  it("takes Flotilla's settings the demo plays with, and no others", () => {
    expect(parseDemo('{"settings": {"flotilla.merge.checks": "local"}, "steps": [{"wait": 1}]}', 'd').settings).toEqual({ 'flotilla.merge.checks': 'local' });
    expect(() => parseDemo('{"settings": {"editor.fontSize": 30}, "steps": [{"wait": 1}]}', 'd')).toThrow(/only Flotilla's settings/);
    expect(() => parseDemo('{"settings": {"flotilla.dev.githubApi": "x"}, "steps": [{"wait": 1}]}', 'd')).toThrow(/not flotilla.dev/);
  });

  it('says what is wrong, and in which step', () => {
    expect(() => parseDemo('{', 'd')).toThrow(/d: not JSON/);
    expect(() => parseDemo('{"steps": []}', 'd')).toThrow(/at least one step/);
    expect(() => parseDemo('{"steps": [{"clik": "x"}]}', 'd')).toThrow(/d, step 1: unknown clik/);
    expect(() => parseDemo('{"steps": [{"click": "x", "type": "y"}]}', 'd')).toThrow(/step 1: a step does one thing/);
    expect(() => parseDemo('{"steps": [{"wait": "1s"}]}', 'd')).toThrow(/"wait" takes a number/);
    expect(() => parseDemo('{"steps": [{"click": "  "}]}', 'd')).toThrow(/"click" takes a string/);
    expect(() => parseDemo('{"steps": [{"click": "x", "timeout": -1}]}', 'd')).toThrow(/"timeout"/);
    expect(() => parseDemo('{"steps": [{"drag": "x"}]}', 'd')).toThrow(/"drag" drops "to" a selector/);
    expect(() => parseDemo('{"steps": [{"click": "x", "to": "y"}]}', 'd')).toThrow(/unknown to/);
  });

  it('reads the example in demos/', () => {
    const root = path.resolve(__dirname, '../../..');
    expect(listDemos(root)).toContain('open-ticket');
    expect(parseDemo(fs.readFileSync(demoFile(root, 'open-ticket'), 'utf8')).steps.length).toBeGreaterThan(3);
  });
});

describe('demoFile', () => {
  it('is demos/<name>.json, and a name is never a path', () => {
    expect(demoFile('/r', 'open-ticket')).toBe(path.join('/r', 'demos', 'open-ticket.json'));
    expect(() => demoFile('/r', '../secrets')).toThrow(/isn't a demo's name/);
    expect(() => demoFile('/r', undefined)).toThrow(/isn't a demo's name/);
  });

  it('lists none when there is no demos folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demos-'));
    try {
      expect(listDemos(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('unsafeFrame', () => {
  const profileDir = path.resolve('/r/.vscode-test/demo-profile');
  const argv = ['Code.exe', `--user-data-dir=${profileDir}`, '--extensions-dir=/r/x'];

  it('keeps a frame of the demo window', () => {
    expect(unsafeFrame({ title: '[Extension Development Host] Flotilla demo · .playground', argv }, { profileDir })).toBeUndefined();
    expect(unsafeFrame({ title: 'Flotilla demo · .playground', argv }, { profileDir })).toBeUndefined();
  });

  it('refuses a window that is not VS Code with the demo profile', () => {
    expect(unsafeFrame({ title: 'Flotilla demo', argv: ['Code.exe'] }, { profileDir })).toMatch(/demo profile/);
    expect(unsafeFrame({ title: 'Flotilla demo', argv: ['Code.exe', '--user-data-dir=/home/me/.config/Code'] }, { profileDir })).toMatch(/demo profile/);
    expect(unsafeFrame({ title: 'Flotilla demo', argv: [...argv, '--user-data-dir=/elsewhere'] }, { profileDir })).toMatch(/demo profile/);
  });

  it('refuses a window whose title is not the demo window one', () => {
    expect(unsafeFrame({ title: 'my-repo - Visual Studio Code', argv }, { profileDir })).toMatch(/title/);
    expect(unsafeFrame({ title: 'x Flotilla demo', argv }, { profileDir })).toMatch(/title/);
    expect(unsafeFrame({ argv }, { profileDir })).toMatch(/title/);
  });
});

describe('decodePng', () => {
  it('reads RGB and RGBA, with every row filter', () => {
    // Two pixels a row, (10,20,30) and (40,50,60), in rows filtered with None, Sub, Up, Average and Paeth.
    const image = decodePng(
      png(2, 5, 3, [
        { filter: 0, bytes: [10, 20, 30, 40, 50, 60] },
        { filter: 1, bytes: [10, 20, 30, 30, 30, 30] },
        { filter: 2, bytes: [0, 0, 0, 0, 0, 0] },
        { filter: 3, bytes: [5, 10, 15, 15, 15, 15] },
        { filter: 4, bytes: [0, 0, 0, 0, 0, 0] },
      ]),
    );
    expect(image.width).toBe(2);
    expect(image.height).toBe(5);
    for (let y = 0; y < 5; y++) expect([...image.data.subarray(y * 8, y * 8 + 8)]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    const rgba = decodePng(png(1, 1, 4, [{ filter: 0, bytes: [1, 2, 3, 4] }]));
    expect([...rgba.data]).toEqual([1, 2, 3, 4]);
  });

  it('refuses what it cannot read', () => {
    expect(() => decodePng(Buffer.from('GIF89a----'))).toThrow(/not a PNG/);
  });
});

describe('downscale', () => {
  it('averages the pixels each covers, and leaves a small image as it is', () => {
    const image = { width: 2, height: 2, data: new Uint8Array([0, 0, 0, 255, 100, 100, 100, 255, 100, 100, 100, 255, 200, 200, 200, 255]) };
    expect(downscale(image, 4)).toBe(image);
    const half = downscale(image, 1);
    expect(half.width).toBe(1);
    expect(half.height).toBe(1);
    expect([...half.data]).toEqual([100, 100, 100, 255]);
  });
});

/** A 2×2 PNG of the four pixels' colours, left to right, top to bottom. */
function pixels(...colours: [number, number, number][]): Buffer {
  return png(2, 2, 3, [
    { filter: 0, bytes: [...colours[0], ...colours[1]] },
    { filter: 0, bytes: [...colours[2], ...colours[3]] },
  ]);
}

/** The frames a GIF shows, as a viewer draws them (each over the one before), as RGB pixels, with their delays (ms). */
function playGif(gif: Buffer): { rgb: number[]; ms: number }[] {
  const width = gif.readUInt16LE(6);
  const table = (at: number, packed: number) => {
    const size = 3 * 2 ** ((packed & 7) + 1);
    return { colours: gif.subarray(at, at + size), end: at + size };
  };
  let at = 13;
  let global: Buffer = Buffer.alloc(0);
  if (gif[10] & 0x80) ({ colours: global, end: at } = table(13, gif[10]));
  const canvas: number[] = new Array(width * gif.readUInt16LE(8) * 3).fill(0);
  const frames: { rgb: number[]; ms: number }[] = [];
  let control = { transparent: -1, ms: 0 };
  while (gif[at] !== 0x3b) {
    if (gif[at] === 0x21) {
      if (gif[at + 1] === 0xf9) control = { transparent: gif[at + 3] & 1 ? gif[at + 6] : -1, ms: gif.readUInt16LE(at + 4) * 10 };
      at += 2;
      while (gif[at]) at += gif[at] + 1;
      at += 1;
      continue;
    }
    const [left, top, w] = [0, 2, 4].map((o) => gif.readUInt16LE(at + 1 + o));
    let colours = global;
    at += 10;
    if (gif[at - 1] & 0x80) ({ colours, end: at } = table(at, gif[at - 1]));
    const minSize = gif[at++];
    const data: number[] = [];
    while (gif[at]) {
      data.push(...gif.subarray(at + 1, at + 1 + gif[at]));
      at += gif[at] + 1;
    }
    at += 1;
    // LZW, as GIF has it: codes from minSize + 1 bits up, a clear code and an end code.
    const clear = 1 << minSize;
    const indices: number[] = [];
    let dict: number[][] = [];
    let size = minSize + 1;
    let prev: number[] | undefined;
    for (let bit = 0; bit + size <= data.length * 8; ) {
      let code = 0;
      for (let b = 0; b < size; b++, bit++) code |= ((data[bit >> 3] >> (bit & 7)) & 1) << b;
      if (code === clear) {
        dict = Array.from({ length: clear + 2 }, (_, n) => [n]);
        size = minSize + 1;
        prev = undefined;
        continue;
      }
      if (code === clear + 1) break;
      const entry = code < dict.length ? dict[code] : [...prev!, prev![0]];
      indices.push(...entry);
      if (prev) dict.push([...prev, entry[0]]);
      if (dict.length === 1 << size && size < 12) size++;
      prev = entry;
    }
    indices.forEach((index, n) => {
      if (index === control.transparent) return;
      const p = ((top + Math.floor(n / w)) * width + left + (n % w)) * 3;
      canvas.splice(p, 3, ...colours.subarray(index * 3, index * 3 + 3));
    });
    frames.push({ rgb: [...canvas], ms: control.ms });
  }
  return frames;
}

describe('frameGate', () => {
  it('keeps the frames that came before a check that passed', async () => {
    const answers: (string | undefined)[] = [undefined];
    const gate = frameGate(async () => answers.shift());
    gate.add('a');
    gate.add('b');
    await gate.check();
    gate.add('c');
    expect(gate.kept).toEqual(['a', 'b']);
    expect(gate.unsafe).toBeUndefined();
  });

  it('keeps no frame that came while a check ran: the next check covers it', async () => {
    let answer: (value: string | undefined) => void = () => undefined;
    const gate = frameGate(() => new Promise((resolve) => (answer = resolve)));
    gate.add('a');
    const checking = gate.check();
    gate.add('b');
    answer(undefined);
    await checking;
    expect(gate.kept).toEqual(['a']);
  });

  it('drops what waits, and every frame after, once a check fails', async () => {
    const answers = [undefined, 'not the demo window', undefined];
    const gate = frameGate(async () => answers.shift());
    gate.add('a');
    await gate.check();
    gate.add('b');
    expect(await gate.check()).toBe('not the demo window');
    gate.add('c');
    expect(await gate.check()).toBe('not the demo window');
    expect(gate.kept).toEqual(['a']);
    expect(gate.unsafe).toBe('not the demo window');
  });
});

describe('gapStats', () => {
  it("measures the gaps between the frames inside the pointer's moves", () => {
    const ats = [0, 100, 140, 180, 260, 1000, 1500, 1540];
    expect(gapStats(ats, [[100, 260], [1500, 1600]])).toEqual({ median: 40, p90: 80, count: 4 });
  });

  it('is undefined without two frames in a move', () => {
    expect(gapStats([0, 500], [[100, 400]])).toBeUndefined();
  });
});

describe('timeline', () => {
  it('times each frame from when it was drawn, not when it came', () => {
    const red = solid(255, 0, 0);
    const blue = solid(0, 0, 255);
    // Out of order, as frames may come: each still shows from when it was drawn.
    const frames = timeline(
      [
        { at: 400, png: red },
        { at: 0, png: blue },
      ],
      1000,
    );
    expect(frames.map((f) => [f.at, f.ms])).toEqual([[0, 400], [400, 600]]);
    expect(frames[0].png).toBe(blue);
  });

  it('starts with the last frame drawn before the start, and leaves out those before it', () => {
    const red = solid(255, 0, 0);
    const blue = solid(0, 0, 255);
    const frames = timeline(
      [
        { at: -3000, png: red },
        { at: -1500, png: blue },
        { at: 800, png: red },
      ],
      1000,
    );
    expect(frames.map((f) => [f.at, f.ms])).toEqual([[0, 800], [800, 200]]);
    expect(frames[0].png).toBe(blue);
  });

  it('keeps 25 frames a second: the last drawn in each 40 ms', () => {
    const colours = [solid(255, 0, 0), solid(0, 255, 0), solid(0, 0, 255), solid(255, 255, 0)];
    // Drawn at 60 a second.
    const frames = timeline(
      colours.map((png, n) => ({ at: Math.round((n * 1000) / 60), png })),
      200,
    );
    expect(FRAME_MS).toBe(40);
    expect(frames.map((f) => [f.at, f.ms])).toEqual([[0, 40], [40, 160]]);
    expect(frames.map((f) => f.png)).toEqual([colours[2], colours[3]]);
  });


  it('merges frames that did not change, and each lasts until the next', () => {
    const red = solid(255, 0, 0);
    const blue = solid(0, 0, 255);
    const frames = timeline(
      [
        { at: 0, png: red },
        { at: 120, png: Buffer.from(red) },
        { at: 240, png: blue },
        { at: 360, png: red },
      ],
      1000,
    );
    expect(frames.map((f) => f.ms)).toEqual([240, 120, 640]);
    expect(frames[1].png).toBe(blue);
  });
});

describe('encodeGif', () => {
  it('makes a looping GIF of the frames', () => {
    const gif = encodeGif([
      { png: solid(255, 0, 0), ms: 500 },
      { png: solid(0, 0, 255), ms: 500 },
    ]);
    expect(gif.subarray(0, 6).toString()).toBe('GIF89a');
    expect(gif.readUInt16LE(6)).toBe(2);
    expect(gif.includes(Buffer.from('NETSCAPE2.0'))).toBe(true);
    expect(gif[gif.length - 1]).toBe(0x3b);
  });

  it("makes a GIF whose length the ticket's Demo section reads (BL-135)", () => {
    const gif = encodeGif([
      { png: solid(255, 0, 0), ms: 500 },
      { png: solid(0, 0, 255), ms: 1200 },
    ]);
    expect(gifSeconds(gif)).toBeCloseTo(1.7);
  });

  it('shows each frame as it was, holding only the pixels that changed', () => {
    const [red, blue, white, black]: [number, number, number][] = [[255, 0, 0], [0, 0, 255], [255, 255, 255], [0, 0, 0]];
    const first = pixels(red, blue, white, black);
    const second = pixels(red, blue, black, black);
    const third = pixels(white, blue, black, red);
    const shown = playGif(encodeGif([
      { png: first, ms: 100 },
      { png: second, ms: 200 },
      { png: Buffer.from(second), ms: 300 },
      { png: third, ms: 400 },
    ]));
    // The same frame again only lengthens the one before.
    expect(shown.map((f) => f.ms)).toEqual([100, 500, 400]);
    expect(shown.map((f) => f.rgb)).toEqual([
      [...red, ...blue, ...white, ...black],
      [...red, ...blue, ...black, ...black],
      [...white, ...blue, ...black, ...red],
    ]);
  });

  it('names its demo in a comment that the ticket reads, and that leaves its frames as they were (BL-111)', () => {
    const frames = [{ png: solid(255, 0, 0), ms: 500 }, { png: solid(0, 0, 255), ms: 1200 }];
    const gif = encodeGif(frames, { name: 'try-demo' });
    expect(DEMO_TAG).toBe(READ_TAG);
    expect(recordedDemo(gif)).toBe('try-demo');
    expect(recordedDemo(gif.subarray(-64))).toBe('try-demo');
    expect(gifSeconds(gif)).toBeCloseTo(1.7);
    expect(gif[gif.length - 1]).toBe(0x3b);
    expect(recordedDemo(encodeGif(frames))).toBeUndefined();
  });
});

describe('stepsToPlay', () => {
  it('plays every step, and none to try it yourself', () => {
    const demo = { steps: [{ action: 'click' }, { action: 'wait' }] };
    expect(stepsToPlay(demo, 'play')).toEqual(demo.steps);
    expect(stepsToPlay(demo, 'record')).toEqual(demo.steps);
    expect(stepsToPlay(demo, 'try')).toEqual([]);
  });
});

describe('demoDisplay', () => {
  it("opens an agent's demo on a virtual display, and anyone else's on the screen", () => {
    expect(demoDisplay({ CLAUDECODE: '1', DISPLAY: ':2' })).toBe('virtual');
    expect(demoDisplay({ DISPLAY: ':2' })).toBe('screen');
  });

  it('does what DEMO_DISPLAY says', () => {
    expect(demoDisplay({ DEMO_DISPLAY: 'virtual' })).toBe('virtual');
    expect(demoDisplay({ DEMO_DISPLAY: ' Screen ', CLAUDECODE: '1' })).toBe('screen');
    expect(() => demoDisplay({ DEMO_DISPLAY: 'mine' })).toThrow(/virtual or screen/);
  });
});

describe('freeDisplay', () => {
  it('skips the displays with a socket or a lock', () => {
    const files = new Set(['/tmp/.X11-unix/X0', '/tmp/.X11-unix/X99', '/tmp/.X100-lock', '/tmp/.X11-unix/X101', '/tmp/.X101-lock']);
    expect(freeDisplay((f) => files.has(f))).toBe(102);
    expect(freeDisplay((f) => files.has(f), 0)).toBe(1);
    expect(freeDisplay(() => false, 103)).toBe(103);
  });
});

// BL-190: what the recorder fixes before it starts, and what it says when a step fails.
describe('parseJsonc', () => {
  it('reads settings with comments and trailing commas, as VS Code writes them', () => {
    const text = '{\n  // the theme\n  "a": "http://x/*y*/", /* b */ "b": [1, 2,],\n}\n';
    expect(parseJsonc(text)).toEqual({ a: 'http://x/*y*/', b: [1, 2] });
    expect(parseJsonc('{"a": "say \\"hi\\" // not a comment"}')).toEqual({ a: 'say "hi" // not a comment' });
  });

  it('is undefined for what is not an object', () => {
    expect(parseJsonc('{"a": ')).toBeUndefined();
    expect(parseJsonc('[1]')).toBeUndefined();
  });
});

describe('plainSettings', () => {
  const settingsFile = (text?: string) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'demo-settings-')), 'settings.json');
    if (text !== undefined) fs.writeFileSync(file, text);
    return file;
  };

  it('keeps plain JSON, and a missing file', () => {
    const file = settingsFile('{"a": 1}');
    expect(plainSettings(file)).toBe('kept');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a": 1}');
    expect(plainSettings(settingsFile())).toBe('kept');
  });

  it('rewrites one with comments as plain JSON', () => {
    const file = settingsFile('{ // x\n "a": 1, }');
    expect(plainSettings(file)).toBe('rewritten');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 1 });
  });

  it('moves a broken one aside, so the profile starts afresh', () => {
    const file = settingsFile('{"a": ');
    expect(plainSettings(file)).toBe('moved');
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(`${file}.broken`, 'utf8')).toBe('{"a": ');
  });
});

describe('staleBuild', () => {
  const project = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-build-'));
    fs.mkdirSync(path.join(root, 'src', 'ui'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'src', 'ui', 'app.ts'), '');
    return root;
  };
  const build = (root: string, at: Date) => {
    for (const f of ['extension.js', 'webview.js', 'ticket.js']) {
      fs.writeFileSync(path.join(root, 'dist', f), '');
      fs.utimesSync(path.join(root, 'dist', f), at, at);
    }
  };

  it('says what is missing, or what changed since the build', () => {
    const root = project();
    expect(staleBuild(root)).toBe(`${path.join('dist', 'extension.js')} is missing`);
    build(root, new Date(Date.now() - 60_000));
    expect(staleBuild(root)).toMatch(/^src\/ui.* changed since the last build$/);
  });

  it('is undefined when the build is newer than the sources', () => {
    const root = project();
    build(root, new Date(Date.now() + 60_000));
    expect(staleBuild(root)).toBeUndefined();
  });
});

describe('failureReason', () => {
  it("says the window closed for Playwright's errors about a window gone", () => {
    expect(failureReason(new TypeError("Cannot read properties of undefined (reading '_object')\n    at toImpl"))).toBe(
      "the VS Code window closed or crashed (Cannot read properties of undefined (reading '_object'))",
    );
    expect(failureReason(new Error('locator.waitFor: Target crashed '))).toMatch(/^the VS Code window closed or crashed/);
  });

  it("keeps others' first line", () => {
    expect(failureReason(new Error('nothing visible matches .x after 15000 ms\nCall log: …'))).toBe('nothing visible matches .x after 15000 ms');
  });
});

describe('nearestElements', () => {
  const elements = [
    { tag: 'div', classes: 'menubar-menu-button', label: 'File' },
    { tag: 'button', label: 'Backlog', text: '7' },
    { tag: 'div', classes: 'row backlog-item', text: 'BL-1 Show a run button' },
    { tag: 'button', label: 'Plan the Backlog with Claude' },
  ];

  it('lists those most like what the selector looks for, a plural or typo included', () => {
    expect(nearestElements('[aria-label="Backlogs"]', elements)).toEqual([
      'button aria-label="Backlog" "7"',
      'div.row.backlog-item "BL-1 Show a run button"',
      'button aria-label="Plan the Backlog with Claude"',
    ]);
    expect(nearestElements('.backlog-item:has-text("Show a run")', elements)[0]).toBe('div.row.backlog-item "BL-1 Show a run button"');
  });

  it('lists the first ones when none is like it', () => {
    expect(nearestElements('.zzz', elements, 2)).toEqual(['div.menubar-menu-button aria-label="File"', 'button aria-label="Backlog" "7"']);
  });
});

describe('commandMatches', () => {
  it('is the command typed, not one of the "similar commands" offered for no match', () => {
    expect(commandMatches('Focus on Flotilla View', 'Flotilla: Focus on Flotilla View, Ctrl+K')).toBe(true);
    expect(commandMatches('Zzqx no such command', 'View: Toggle Tree Sticky Scroll, similar commands')).toBe(false);
    expect(commandMatches('Focus on Flotilla View', undefined)).toBe(false);
  });
});

describe('resultLine', () => {
  it('says in one line what was saved, checked, or where it failed', () => {
    expect(resultLine({ saved: '/b/BL-1/demo.gif', bytes: 1.5 * 1024 * 1024, ms: 12_340 })).toBe('Demo saved: /b/BL-1/demo.gif (1.5 MB, 12.3 s)');
    expect(resultLine({ checked: 7, ms: 8000 })).toBe('Demo checked: all 7 steps passed (8.0 s). Record it once now.');
    expect(resultLine({ step: 'step 2 (click ".x")', reason: 'nothing visible matches .x', screenshot: 'demos/a.failed.png' })).toBe(
      'Demo failed: step 2 (click ".x"): nothing visible matches .x (screenshot: demos/a.failed.png)',
    );
  });

  it('fills in the reason, never a template left as text', () => {
    const line = resultLine({ reason: failureReason(new Error('the build failed')) });
    expect(line).toBe('Demo failed: the build failed');
    expect(line).not.toContain('${');
  });
});
