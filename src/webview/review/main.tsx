import { render } from 'preact';
import {
  useEffect,
  useState,
} from 'preact/hooks';
import type {
  ReviewHostMessage,
  ReviewWebviewMessage,
} from '../reviewProtocol';
// The ticket's rules (its rendered Markdown, diagrams, buttons) first, then the review's own.
import '../ticket/ticket.css';
import { send as sendTicket } from '../ticket/actions';
import { Rendered } from '../ticket/markdownBox';
import './review.css';

/** The page's one VS Code API (the ticket's module acquired it): Rendered's links come through it too. */
const send = sendTicket as (message: ReviewWebviewMessage) => void;

/** An improvement review (BL-177): its title, then the review as a ticket shows an entry. */
function Review() {
  const [review, setReview] = useState<ReviewHostMessage | undefined>();
  useEffect(() => {
    const on = (e: MessageEvent<ReviewHostMessage>) => {
      if (e.data.type === 'review') setReview(e.data);
    };
    window.addEventListener('message', on);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', on);
  }, []);
  if (!review) return <p class="review-empty">Reading the review…</p>;
  return (
    <div class="review">
      <div class="review-head">
        <h1>{review.title}</h1>
        <button class="button secondary" onClick={() => send({ type: 'openFile' })} title="Edit the review as Markdown">
          <i class="codicon codicon-edit" /> Edit
        </button>
      </div>
      <Rendered html={review.html} empty={review.missing ? `The review of ${review.day} isn't there anymore.` : 'The review is being written…'} />
    </div>
  );
}

render(<Review />, document.getElementById('root')!);
