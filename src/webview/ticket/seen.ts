/**
 * A demo plays only while you can see it (BL-228): ticket tabs keep running when hidden, and a looping video in each
 * kept the GPU's video decoder busy. It pauses while its tab is hidden or it's out of view (scrolled away, in a closed
 * fold) and plays on when it's seen again, unless you paused it yourself.
 */

/** What it needs of a video (an HTMLVideoElement has it). */
export interface Playable extends EventTarget {
  readonly paused: boolean;
  play(): Promise<void> | void;
  pause(): void;
}

/** Where it looks: the document (is its tab showing) and an IntersectionObserver (is it in view). */
export interface Seeing {
  doc: EventTarget & { readonly visibilityState: string };
  Observer?: new (callback: (entries: { isIntersecting: boolean }[]) => void) => { observe(el: never): void; disconnect(): void };
}

/** Plays a video while its tab is showing and it's in view, pauses it otherwise. Returns what stops it. */
export function playWhileSeen(video: Playable, { doc, Observer }: Seeing): () => void {
  // Until the observer first says, it isn't in view; without one, it is.
  let inView = !Observer;
  // The user paused it with its controls: it stays paused until they play it.
  let held = false;
  // The pause events this causes, not the user's.
  let pausing = 0;
  const update = () => {
    const seen = inView && doc.visibilityState !== 'hidden';
    if (seen && !held && video.paused) {
      void Promise.resolve(video.play()).catch(() => undefined);
    } else if (!seen && !video.paused) {
      pausing++;
      video.pause();
    }
  };
  const paused = () => {
    if (pausing > 0) pausing--;
    else held = true;
  };
  const played = () => {
    held = false;
  };
  video.addEventListener('pause', paused);
  video.addEventListener('play', played);
  doc.addEventListener('visibilitychange', update);
  const observer = Observer
    ? new Observer((entries) => {
        inView = entries[entries.length - 1]?.isIntersecting ?? inView;
        update();
      })
    : undefined;
  observer?.observe(video as never);
  update();
  return () => {
    observer?.disconnect();
    doc.removeEventListener('visibilitychange', update);
    video.removeEventListener('pause', paused);
    video.removeEventListener('play', played);
  };
}
