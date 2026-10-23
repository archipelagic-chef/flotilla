import { glitchLine } from '../../features/backlog/ticketCheck';
import type { TicketCheckView } from '../ticketProtocol';
import { ActionButton } from './actions';

/**
 * A ticket's Check (BL-163). Clicked: each claim, ✓ with its evidence or ✗ with Clean Up (one, or all). Made on
 * opening the ticket: only a line, when something isn't what it says, so you're told before a button refuses.
 */
export function CheckResult({ check }: { check: TicketCheckView }) {
  const bad = check.claims.filter((c) => !c.ok);
  if (!check.full) {
    if (!bad.length) return null;
    return (
      <div class="error-note check-note">
        <i class="codicon codicon-pulse" /> {glitchLine(bad)} ·{' '}
        <ActionButton class="text-button" message={{ type: 'check' }} working="Checking…" title="Checks what the ticket says is going on, to clean up what isn't">
          Check
        </ActionButton>
      </div>
    );
  }
  return (
    <div class={`check-result ${bad.length ? 'glitched' : ''}`}>
      <div class="check-head">
        <i class="codicon codicon-pulse" /> Checked at {check.at}
        {check.error
          ? `: ${check.error}`
          : !check.claims.length
            ? ': nothing is said to be going on.'
            : bad.length
              ? `: ${bad.length} of ${check.claims.length} ${check.claims.length === 1 ? "isn't" : "aren't"} what ${check.claims.length === 1 ? 'it says' : 'they say'}.`
              : ': all as it says.'}
        {bad.length > 1 && (
          <ActionButton class="button" message={{ type: 'checkCleanUp' }} working="Cleaning up…" title="Cleans up every ✗ below (asks before stopping a process), with a note in the activity">
            Clean Up All
          </ActionButton>
        )}
      </div>
      <ul>
        {check.claims.map((c) => (
          <li key={c.key} class={c.ok ? 'ok' : 'glitch'}>
            <span class="check-mark">{c.ok ? '✓' : '✗'}</span> {c.text}
            {!c.ok && c.fix && (
              <>
                {' '}→{' '}
                <ActionButton class="text-button" message={{ type: 'checkCleanUp', key: c.key }} working="Cleaning up…" title={`Clean Up: ${c.fix}, with a note in the activity`}>
                  Clean Up
                </ActionButton>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
