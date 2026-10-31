import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  playWhileSeen,
  type Seeing,
} from '../../../src/webview/ticket/seen';

/** BL-228: a looping demo plays only while its tab is showing and it's in view. */

/** A video: play and pause fire their events later, as a browser's do. */
class Video extends EventTarget {
  paused = true;
  play() {
    this.paused = false;
    queueMicrotask(() => this.dispatchEvent(new Event('play')));
  }
  pause() {
    this.paused = true;
    queueMicrotask(() => this.dispatchEvent(new Event('pause')));
  }
}

function setup() {
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  let seen: (entries: { isIntersecting: boolean }[]) => void = () => undefined;
  let watching = false;
  class Observer {
    constructor(callback: typeof seen) {
      seen = callback;
    }
    observe() {
      watching = true;
    }
    disconnect() {
      watching = false;
    }
  }
  const video = new Video();
  const stop = playWhileSeen(video, { doc, Observer } as Seeing);
  const tick = () => new Promise((r) => setTimeout(r));
  return {
    video,
    stop,
    tick,
    watching: () => watching,
    inView: (isIntersecting: boolean) => seen([{ isIntersecting }]),
    tab: (state: 'visible' | 'hidden') => {
      doc.visibilityState = state;
      doc.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

describe('playWhileSeen', () => {
  it('waits until it is in view, then plays', () => {
    const t = setup();
    expect(t.video.paused).toBe(true);
    t.inView(true);
    expect(t.video.paused).toBe(false);
  });

  it('pauses while its tab is hidden and plays on when it is shown', async () => {
    const t = setup();
    t.inView(true);
    await t.tick();
    t.tab('hidden');
    expect(t.video.paused).toBe(true);
    await t.tick();
    t.tab('visible');
    expect(t.video.paused).toBe(false);
  });

  it('pauses when it leaves the view and plays on when it is back', async () => {
    const t = setup();
    t.inView(true);
    await t.tick();
    t.inView(false);
    expect(t.video.paused).toBe(true);
    await t.tick();
    t.inView(true);
    expect(t.video.paused).toBe(false);
  });

  it('does not play in a hidden tab when it comes into view', () => {
    const t = setup();
    t.tab('hidden');
    t.inView(true);
    expect(t.video.paused).toBe(true);
  });

  it('keeps a video the user paused paused, until they play it', async () => {
    const t = setup();
    t.inView(true);
    await t.tick();
    t.video.pause();
    await t.tick();
    t.tab('hidden');
    t.tab('visible');
    t.inView(false);
    t.inView(true);
    expect(t.video.paused).toBe(true);
    t.video.play();
    await t.tick();
    t.inView(false);
    expect(t.video.paused).toBe(true);
    await t.tick();
    t.inView(true);
    expect(t.video.paused).toBe(false);
  });

  it('stops watching when it is stopped', () => {
    const t = setup();
    t.inView(true);
    t.stop();
    expect(t.watching()).toBe(false);
    t.tab('hidden');
    expect(t.video.paused).toBe(false);
  });
});
