import { useEffect, useState } from 'preact/hooks';
import { fraction, progressLine, elapsed } from '../../features/backlog/checksProgress';
import type { ChecksRunRecord } from '../../features/backlog/merge';
import type { MergeChecksView } from '../ticketProtocol';
import { ActionButton, send } from './actions';
import './checksPanel.css';

/** Show All's replies (BL-169): a run's whole log, by request. */
export const checksLogReplies = new Map<number, (text: string) => void>();
let nextLog = 1;

/** The time now, again every second. */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** "8 tests timed out", "you stopped it", "3 tests failed". */
function runOutcome(r: ChecksRunRecord): string {
  if (r.stopped) return 'you stopped it';
  if (r.timeouts) return `only timeouts: ${r.timeouts} test${r.timeouts === 1 ? '' : 's'} timed out`;
  return r.failures.length ? `${r.failures.length} test${r.failures.length === 1 ? '' : 's'} failed` : 'failed';
}

/** A run's log: Show All brings all of it into the ticket (Ctrl+F finds in it); Open in Terminal follows it there. */
function LogActions({ log }: { log: string }) {
  const [text, setText] = useState<string>();
  const [open, setOpen] = useState(false);
  const showAll = () => {
    if (open) return setOpen(false);
    setOpen(true);
    const requestId = nextLog++;
    checksLogReplies.set(requestId, (t) => setText(t));
    send({ type: 'mergeChecksLog', requestId, log });
  };
  return (
    <>
      <span class="checks-log-actions">
        <button class="text-button" onClick={showAll} title="The whole log, in the ticket: Ctrl+F finds in it">
          <i class={`codicon codicon-${open ? 'fold' : 'unfold'}`} /> {open ? 'Hide the Log' : 'Show All'}
        </button>
        <button
          class="text-button"
          onClick={() => send({ type: 'mergeChecksTerminal', log })}
          title="The same log, followed as it's written, in a terminal named after the ticket"
        >
          <i class="codicon codicon-terminal" /> Open in Terminal
        </button>
      </span>
      {open && <pre class="checks-log">{text === undefined ? 'Loading…' : text.trim() || '(no output)'}</pre>}
    </>
  );
}

/**
 * A merge's checks running in the background (BL-169): the step, how far it is and for how long, what it waits for,
 * the last lines (folded), the whole log, and Stop.
 */
export function ChecksRunning({ checks }: { checks: MergeChecksView }) {
  const now = useNow();
  const p = checks.progress;
  const part = fraction(p);
  const earlier = checks.earlier.at(-1);
  return (
    <div class="merge-checks">
      <div class="review-panel working">
        <i class="codicon codicon-loading codicon-modifier-spin" />
        <span class="review-text">
          <strong>{progressLine(p, now - checks.started)}</strong>
          {p.failedFiles > 0 && <span class="checks-failing"> · {p.failedFiles} failing</span>}
          {p.wait && <> · Waiting for a test slot: {p.wait}</>}
          {earlier && (
            <span class="muted">
              {' '}
              Run {checks.earlier.length + 1}: the first {runOutcome(earlier)}.
            </span>
          )}
          <span class="muted checks-command">
            {' '}
            <code>{checks.command}</code>
          </span>
        </span>
        <ActionButton
          class="button secondary"
          message={{ type: 'mergeChecksStop' }}
          working="Stopping…"
          title="Stops the checks: the merge stops, kept for you to run them again or cancel"
        >
          <i class="codicon codicon-debug-stop" /> Stop
        </ActionButton>
      </div>
      {part !== undefined && (
        <div class="checks-bar" title={`${Math.round(part * 100)}%`}>
          <div style={{ width: `${part * 100}%` }} />
        </div>
      )}
      <details class="merge-output">
        <summary>{checks.tail.at(-1)?.trim() || 'The last lines of output'}</summary>
        <pre>{checks.tail.join('\n').trim() || '(no output yet)'}</pre>
      </details>
      <LogActions log={checks.log} />
    </div>
  );
}

/** A merge's failed runs of the checks (BL-169): what failed in each, with its error, and its log. */
export function ChecksRuns({ runs }: { runs: readonly ChecksRunRecord[] }) {
  return (
    <div class="checks-runs">
      {runs.map((r, i) => (
        <div key={r.log} class="checks-run">
          <div class="checks-run-head">
            <i class={`codicon codicon-${r.stopped ? 'debug-stop' : r.timeouts ? 'watch' : 'error'}`} />
            <strong>{runs.length > 1 ? `Run ${i + 1}` : 'The checks'}</strong>: {runOutcome(r)}, after {elapsed(r.ms)}.
            {r.timeouts > 0 && i < runs.length - 1 && <span class="muted"> Often a loaded machine: they ran once more.</span>}
          </div>
          {r.failures.length > 0 && (
            <ul class="checks-failures">
              {r.failures.map((f) => (
                <li key={f.test}>
                  <code>{f.test}</code>
                  {f.error.length > 0 && <pre>{f.error.join('\n')}</pre>}
                </li>
              ))}
            </ul>
          )}
          <LogActions log={r.log} />
        </div>
      ))}
    </div>
  );
}
