import { render } from 'preact';
import {
  useEffect,
  useState,
} from 'preact/hooks';
import type { PageHostMessage } from '../pageProtocol';
// The ticket's rules for rendered Markdown (diagrams, task lists, file links), then the page's own.
import '../ticket/ticket.css';
import { send } from '../ticket/actions';
import { Rendered } from '../ticket/markdownBox';
import './page.css';

/** A page tab (BL-260): a report rendered as a ticket's entries are; its links open as they do in a ticket. */
function Page() {
  const [page, setPage] = useState<PageHostMessage | undefined>(undefined);
  useEffect(() => {
    const listener = (e: MessageEvent<PageHostMessage>) => {
      if (e.data.type === 'page') setPage(e.data);
    };
    window.addEventListener('message', listener);
    (send as (m: unknown) => void)({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, []);
  if (!page) return <div class="page empty-text">Loading…</div>;
  return (
    <div class="page">
      <Rendered html={page.html} empty="This report is empty." />
    </div>
  );
}

render(<Page />, document.getElementById('root')!);
