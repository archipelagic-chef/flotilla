import './demo.css';
/**
 * The Demo section (BL-135), under the description: the proof that the ticket is delivered. The latest recording,
 * large and playing, as the demo unit (BL-111): "Recorded demo · 0:12", Try it yourself and Watch it live; when and by
 * whom it was recorded, whether the work changed since, and the earlier recordings, folded.
 */
import type { ComponentChildren, JSX } from 'preact';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'preact/hooks';
import { entryAgent } from '../../features/backlog/backlog';
import {
  DEMO_SPEEDS,
  demoLabel,
  demoRunFor,
  gifSeconds,
  speedLabel,
  staleNote,
  ticketDemo,
  wantsDemo,
} from '../../features/backlog/demo';
import {
  isGif,
  pickSpeed,
  playGifAtSpeed,
  playVideoAtSpeed,
  useSpeed,
} from './speed';
import type { AttachmentView, TicketView, TicketWebviewMessage } from '../ticketProtocol';

/** The section's id: a review card's demo mark opens the ticket there. */
export const DEMO_SECTION = 'demo';

export type Action = (
  props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { message: TicketWebviewMessage; working?: string; children?: ComponentChildren },
) => JSX.Element;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-20 07:00" as "Oct 20, 07:00". */
function shortDate(date: string): string {
  const m = /^\d{4}-(\d\d)-(\d\d) (\d\d:\d\d)$/.exec(date);
  return m ? `${MONTHS[Number(m[1]) - 1]} ${Number(m[2])}, ${m[3]}` : date;
}

/** "Recorded by Iris-3, Oct 20, 07:00, round 2". */
function recorded(a: AttachmentView, round?: number): string {
  const who = a.author ? `by ${entryAgent(a.author) ?? a.author}` : a.from === 'folder' ? 'in the ticket’s folder' : '';
  return ['Recorded' + (who ? ` ${who}` : ''), a.date && shortDate(a.date), round && `round ${round}`].filter(Boolean).join(', ');
}

/** How long it plays: a video's from its metadata, a GIF's from its frames' delays (it's read once). */
function useLength(a: AttachmentView): [number | undefined, (seconds: number) => void] {
  const [seconds, setSeconds] = useState<number | undefined>(undefined);
  useEffect(() => {
    setSeconds(undefined);
    if (a.kind === 'video' || !isGif(a.src)) return;
    let gone = false;
    fetch(a.src)
      .then((r) => r.arrayBuffer())
      .then((b) => !gone && setSeconds(gifSeconds(new Uint8Array(b))))
      .catch(() => undefined);
    return () => void (gone = true);
  }, [a.src]);
  return [seconds, setSeconds];
}

/** A recording playing: a video muted and looping (BL-134), a GIF as it is; at the speed demos play at (BL-218). */
function Recording({ a, onLength }: { a: AttachmentView; onLength?: (seconds: number) => void }) {
  const el = useRef<HTMLVideoElement & HTMLImageElement>(null);
  useEffect(() => {
    const media = el.current;
    if (!media) return;
    return a.kind === 'video' ? playVideoAtSpeed(media) : isGif(a.src) ? playGifAtSpeed(media) : undefined;
  }, [a.src, a.kind]);
  return a.kind === 'video' ? (
    <video
      ref={el}
      key={a.src}
      src={a.src}
      autoPlay
      muted
      loop
      playsInline
      controls
      aria-label={a.alt ?? a.name}
      onLoadedMetadata={(e) => onLength?.((e.currentTarget as HTMLVideoElement).duration)}
    />
  ) : (
    <img ref={el} key={a.src} src={a.src} alt={a.alt ?? a.name} />
  );
}

/** 1×, 1.5×, 2× (BL-218): the speed every demo plays at, the one it plays at marked. */
export function SpeedControl() {
  const speed = useSpeed();
  return (
    <span class="demo-speed" role="group" aria-label="Speed">
      {DEMO_SPEEDS.map((s) => (
        <button key={s} type="button" class="demo-speed-option" aria-pressed={s === speed} title={`Play at ${speedLabel(s)}`} onClick={() => pickSpeed(s)}>
          {speedLabel(s)}
        </button>
      ))}
    </span>
  );
}

export function DemoSection({ ticket, Action }: { ticket: TicketView; Action: Action }) {
  const list = ticket.attachments ?? [];
  const demo = useMemo(() => ticketDemo(list, ticket.activity, ticket.commits), [list, ticket.activity, ticket.commits]);
  const missing = !demo && wantsDemo(ticket.activity);
  if (!demo && !missing) return null;
  return (
    <section class="block demo-section" id={DEMO_SECTION}>
      <div class="block-head">
        <h2>Demo</h2>
      </div>
      {demo ? (
        <DemoUnit demo={demo} Action={Action} />
      ) : (
        <p class="demo-missing muted">
          <i class="codicon codicon-device-camera-video" /> No demo yet: the work changes something you see or click, and it wasn’t recorded.
        </p>
      )}
    </section>
  );
}

/**
 * The demo unit's bar (BL-111), over a recording: "Recorded demo · 0:12" (at the speed it plays at), the speed
 * (BL-218), Try it yourself and Watch it live (with the `run demo` block it goes with). The Demo section's, and the
 * Attachments viewer's.
 */
export function DemoBar({ seconds, run, Action }: { seconds?: number; run?: { key: string; index: number; name: string }; Action: Action }) {
  const speed = useSpeed();
  return (
    <div class="demo-bar">
      <span class="demo-label">
        <i class="codicon codicon-device-camera-video" /> {demoLabel(seconds, speed)}
      </span>
      <SpeedControl />
      {run && (
        <>
          <Action
            class="button"
            message={{ type: 'run', key: run.key, index: run.index, try: true }}
            working="Starting…"
            title={`Opens the demo "${run.name}"'s window as it starts, in the ticket's worktree, and leaves it to you (npm run demo -- try ${run.name})`}
          >
            <i class="codicon codicon-debug-start" /> Try it yourself
          </Action>
          <Action
            class="button secondary"
            message={{ type: 'run', key: run.key, index: run.index }}
            working="Playing…"
            title={`Plays the demo "${run.name}" live, in the ticket's worktree (npm run demo -- play ${run.name})`}
          >
            <i class="codicon codicon-play" /> Watch it live
          </Action>
        </>
      )}
    </div>
  );
}

/** The bar for one of the ticket's recordings, with the run block it goes with. */
export function RecordingBar({ a, ticket, Action }: { a: AttachmentView; ticket: TicketView; Action: Action }) {
  const run = useMemo(() => demoRunFor(a, ticket.activity), [a, ticket.activity]);
  const [seconds] = useLength(a);
  return <DemoBar seconds={seconds ?? a.seconds} run={run} Action={Action} />;
}

function DemoUnit({ demo, Action }: { demo: NonNullable<ReturnType<typeof ticketDemo<AttachmentView>>>; Action: Action }) {
  const a = demo.latest;
  const [seconds, setSeconds] = useLength(a);
  return (
    <div class="demo-unit">
      <DemoBar seconds={seconds ?? a.seconds} run={demo.run} Action={Action} />
      {demo.since > 0 && (
        <p class="demo-stale">
          <i class="codicon codicon-warning" /> {staleNote(demo.since)}
        </p>
      )}
      <figure class="demo-figure">
        <Recording a={a} onLength={setSeconds} />
        <figcaption>
          {a.alt && <span class="demo-caption">{a.alt}</span>}
          <span class="muted">{recorded(a, demo.round)}</span>
        </figcaption>
      </figure>
      {demo.earlier.length > 0 && (
        <details class="demo-earlier">
          <summary>
            {demo.earlier.length} earlier recording{demo.earlier.length > 1 ? 's' : ''}
          </summary>
          <ul>
            {demo.earlier.map((e) => (
              <li key={e.src}>
                <Recording a={e} />
                <span class="muted">
                  {e.alt ? `${e.alt} · ` : ''}
                  {recorded(e)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
