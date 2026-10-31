import {
  useLayoutEffect,
  useRef,
  useState,
} from 'preact/hooks';
import type { TicketView } from '../ticketProtocol';
import { send } from './actions';
import {
  MarkdownBox,
  mentionPrefix,
  Rendered,
} from './markdownBox';
import './description.css';

/** A new description starts from its shape: the user (or an agent) fills it in (BL-137). */
export const DESCRIPTION_SKELETON = "**When it's done:** \n\n**Why:** \n\nAcceptance criteria:\n- [ ] \n";

/** The empty description's placeholder: the shape a description takes. */
const DESCRIPTION_PLACEHOLDER =
  "**When it's done:** what you see and can do, in 1–4 lines.\n\n**Why:** what's wrong today, and its cause.\n\nAcceptance criteria:\n- [ ] …\n\nIn Markdown. Paste or drop images and videos. Ctrl+Enter saves.";

/** What the editor starts with: the description, or the shape for a local ticket without one. */
function startDraft(ticket: TicketView): string {
  return ticket.description.trim() || ticket.remote ? ticket.description : DESCRIPTION_SKELETON;
}

export function Description({ ticket }: { ticket: TicketView }) {
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const editable = !ticket.remote || !!ticket.remote.edit?.canEditDescription;
  const jira = ticket.remote?.kind === 'jira';
  // With activity, the description folds to its first lines (the history is what's new).
  const foldable = ticket.activity.length > 0;
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const text = useRef<HTMLDivElement>(null);
  // Folded, a description with "When it's done" lines shows those, in place of its first lines (BL-137).
  const folded = foldable && !expanded;
  useLayoutEffect(() => {
    // Measured while folded only: unfolded, it always fits.
    const el = text.current;
    if (el && !expanded) setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [ticket.descriptionHtml, foldable, expanded]);
  const save = () => {
    if (draft !== undefined && draft !== ticket.description && !(draft === DESCRIPTION_SKELETON && !ticket.description.trim()))
      send({ type: 'description', text: draft });
    setDraft(undefined);
  };
  return (
    <section class="block">
      <div class="block-head">
        <h2>Description</h2>
        <span class="head-actions">
          {draft === undefined && editable && !ticket.loading && (
            <button class="text-button" onClick={() => setDraft(startDraft(ticket))}>
              <i class="codicon codicon-edit" /> Edit
            </button>
          )}
          {ticket.remote && (
            <button class="text-button" onClick={() => send({ type: 'openRemote' })}>
              <i class="codicon codicon-link-external" /> Open in {jira ? 'Jira' : 'GitHub'}
            </button>
          )}
        </span>
      </div>
      {ticket.loading ? (
        <div class="rendered empty-text">Loading from {ticket.remote?.label ?? 'its tracker'}…</div>
      ) : draft === undefined ? (
        <>
          <div
            ref={text}
            class={folded ? (ticket.whenDoneHtml ? 'description when-done' : 'description folded') : 'description'}
            onDblClick={() => editable && setDraft(startDraft(ticket))}
          >
            {folded && ticket.whenDoneHtml ? (
              <Rendered html={ticket.whenDoneHtml} empty="" />
            ) : (
              <Rendered html={ticket.descriptionHtml} empty={ticket.remote ? 'No description.' : 'No description yet. Edit it, or discuss it with an agent.'} />
            )}
          </div>
          {foldable && (overflows || expanded || !!ticket.whenDoneHtml) && (
            <button class="text-button fold-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              <i class={`codicon codicon-chevron-${expanded ? 'up' : 'down'}`} /> {expanded ? 'Fold the description' : 'Show the whole description'}
            </button>
          )}
        </>
      ) : (
        <>
          <MarkdownBox
            value={draft}
            setValue={setDraft}
            placeholder={
              jira
                ? 'In Jira formatting (h2. Heading, *bold*, * list). Ctrl+Enter saves it in Jira.'
                : ticket.remote
                  ? 'Markdown. Ctrl+Enter saves it in GitHub.'
                  : DESCRIPTION_PLACEHOLDER
            }
            label="Description"
            onSubmit={save}
            autoFocus
            minRows={8}
            images={!ticket.remote}
            format={jira ? 'jira' : 'markdown'}
            mention={mentionPrefix(ticket.item.id)}
          />
          {jira && <div class="hint">Jira's own formatting: this is the description as Jira stores it.</div>}
          <div class="actions-row">
            <button class="button" onClick={save}>
              Save
            </button>
            <button class="button secondary" onClick={() => setDraft(undefined)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </section>
  );
}
