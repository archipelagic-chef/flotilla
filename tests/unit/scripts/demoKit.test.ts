import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, demoFile, downscale, encodeGif, listDemos, parseDemo, timeline, unsafeFrame } from '../../../scripts/demo-kit.mjs';

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
    const demo = parseDemo(JSON.stringify({ title: 'T', steps: [{ command: 'Focus on Flotilla View' }, { click: 'text=BL-3', timeout: 5000 }, { hover: '.ci-run' }, { wait: 500 }, { caption: '' }] }));
    expect(demo).toEqual({
      title: 'T',
      steps: [
        { action: 'command', value: 'Focus on Flotilla View' },
        { action: 'click', value: 'text=BL-3', timeout: 5000 },
        { action: 'hover', value: '.ci-run' },
        { action: 'wait', value: 500 },
        { action: 'caption', value: '' },
      ],
    });
  });

  it('says what is wrong, and in which step', () => {
    expect(() => parseDemo('{', 'd')).toThrow(/d: not JSON/);
    expect(() => parseDemo('{"steps": []}', 'd')).toThrow(/at least one step/);
    expect(() => parseDemo('{"steps": [{"clik": "x"}]}', 'd')).toThrow(/d, step 1: unknown clik/);
    expect(() => parseDemo('{"steps": [{"click": "x", "type": "y"}]}', 'd')).toThrow(/step 1: a step does one thing/);
    expect(() => parseDemo('{"steps": [{"wait": "1s"}]}', 'd')).toThrow(/"wait" takes a number/);
    expect(() => parseDemo('{"steps": [{"click": "  "}]}', 'd')).toThrow(/"click" takes a string/);
    expect(() => parseDemo('{"steps": [{"click": "x", "timeout": -1}]}', 'd')).toThrow(/"timeout"/);
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

describe('timeline', () => {
  it('merges frames that did not change, and each lasts until the next', () => {
    const red = solid(255, 0, 0);
    const blue = solid(0, 0, 255);
    const frames = timeline(
      [
        { at: 0, png: red },
        { at: 125, png: Buffer.from(red) },
        { at: 250, png: blue },
        { at: 375, png: red },
      ],
      1000,
    );
    expect(frames.map((f) => f.ms)).toEqual([250, 130, 630]);
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
});
