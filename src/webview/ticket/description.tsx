import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { TicketView } from '../ticketProtocol';
import { send } from './actions';
import { MarkdownBox, mentionPrefix, Rendered } from './markdownBox';
import './description.css';

export function Description({ ticket }: { ticket: TicketView }) {
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const editable = !ticket.remote || !!ticket.remote.edit?.canEditDescription;
  const jira = ticket.remote?.kind === 'jira';
  // With activity, the description folds to its first lines (the history is what's new).
  const foldable = ticket.activity.length > 0;
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const text = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Measured while folded only: unfolded, it always fits.
    const el = text.current;
    if (el && !expanded) setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [ticket.descriptionHtml, foldable, expanded]);
  const save = () => {
    if (draft !== undefined && draft !== ticket.description) send({ type: 'description', text: draft });
    setDraft(undefined);
  };
  return (
    <section class="block">
      <div class="block-head">
        <h2>Description</h2>
        <span class="head-actions">
          {draft === undefined && editable && !ticket.loading && (
            <button class="text-button" onClick={() => setDraft(ticket.description)}>
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
          <div ref={text} class={foldable && !expanded ? 'description folded' : 'description'} onDblClick={() => editable && setDraft(ticket.description)}>
            <Rendered html={ticket.descriptionHtml} empty={ticket.remote ? 'No description.' : 'No description yet. Edit it, or discuss it with an agent.'} />
          </div>
          {foldable && (overflows || expanded) && (
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
                  : 'What and why, in Markdown. Paste or drop images and videos. Ctrl+Enter saves.'
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
