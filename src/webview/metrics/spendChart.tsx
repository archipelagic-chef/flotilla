import { useState } from 'preact/hooks';
import type { SpendCell, SpendChat, SpendTimeline } from '../metricsProtocol';
import {
  type Bucket,
  buckets,
  MOST_CHATS,
  tokensOf,
  topChats,
  type Window,
  WINDOWS,
} from './spendBuckets';
import { formatValue } from './view';

/**
 * Spend over time (BL-202): tokens or dollars per hour (per day, over 7 days), stacked by the chat that spent them.
 * Hovering a column says what's in it; picking it, or a chat in the legend, lists its chats, each opening its ticket
 * (an agent's) or itself.
 */

const COLORS = [
  ...['blue', 'orange', 'purple', 'green', 'red', 'yellow'].map((c) => `var(--vscode-charts-${c})`),
  'var(--vscode-terminal-ansiCyan)',
  'var(--vscode-terminal-ansiMagenta)',
];
const OTHERS_COLOR = 'var(--vscode-descriptionForeground)';

interface Picked {
  title: string;
  rows: Array<{ chat: SpendChat; cell: SpendCell; when?: string }>;
}

export function SpendOverTime(props: { timeline: SpendTimeline; now: number; openTicket(id: string): void; openChat(session: string, cwd?: string): void }) {
  const { timeline, now } = props;
  const [window, setWindow] = useState<Window>('24h');
  const [unit, setUnit] = useState<'tokens' | 'usd'>('tokens');
  const [picked, setPicked] = useState<{ key: string; list: Picked } | undefined>();
  const value = unit === 'usd' ? (c: SpendCell) => c.costUsd : tokensOf;
  const bs = buckets(timeline, window, now);
  const { shown, others } = topChats(bs, value);
  const series = [
    ...shown.map((chat) => ({ label: timeline.chats[chat].label, chats: [chat] })),
    ...(others.size ? [{ label: 'Others', chats: [...others] }] : []),
  ];
  const colorOf = (i: number) => (i < shown.length ? COLORS[i % COLORS.length] : OTHERS_COLOR);
  const stacks = bs.map((b) => series.map((s) => s.chats.reduce((n, chat) => n + (b.cells.get(chat) ? value(b.cells.get(chat)!) : 0), 0)));
  const totals = stacks.map((s) => s.reduce((a, x) => a + x, 0));
  const max = Math.max(0, ...totals);
  const pick = (key: string, list: () => Picked) => setPicked((was) => (was?.key === key ? undefined : { key, list: list() }));
  const choose = (w: Window) => {
    setWindow(w);
    setPicked(undefined);
  };
  const byValue = (a: { cell: SpendCell }, b: { cell: SpendCell }) => value(b.cell) - value(a.cell);
  const columnRows = (b: Bucket) =>
    [...b.cells.entries()]
      .map(([chat, cell]) => ({ chat: timeline.chats[chat], cell }))
      .filter((r) => value(r.cell) > 0 || r.cell.turns)
      .sort(byValue);
  const tip = (i: number) => {
    const rows = columnRows(bs[i]);
    if (!rows.length) return `${bs[i].label}: nothing spent`;
    return [
      `${bs[i].label}: ${formatValue(totals[i], unit)}`,
      ...rows.slice(0, MOST_CHATS).map((r) => `${r.chat.label}: ${formatValue(value(r.cell), unit)}`),
    ].join('\n');
  };
  const every = Math.ceil(bs.length / 8);
  return (
    <div class="metrics-chart spend-over-time">
      <h4>Spend over time</h4>
      <div class="metrics-bar">
        <div class="metrics-periods" role="radiogroup" aria-label="Window">
          {WINDOWS.map((w) => (
            <button key={w.id} role="radio" aria-checked={w.id === window} class={w.id === window ? 'on' : ''} onClick={() => choose(w.id)}>
              {w.label}
            </button>
          ))}
        </div>
        <div class="metrics-periods spend-unit" role="radiogroup" aria-label="Unit">
          {(['tokens', 'usd'] as const).map((u) => (
            <button key={u} role="radio" aria-checked={u === unit} class={u === unit ? 'on' : ''} onClick={() => setUnit(u)}>
              {u === 'usd' ? '$' : 'Tokens'}
            </button>
          ))}
        </div>
      </div>
      {!max ? (
        <p class="metrics-empty">No chat spent anything in the last {WINDOWS.find((w) => w.id === window)!.label}</p>
      ) : (
        <div>
          <div class="metrics-legend">
            {series.map((s, i) => (
              <button
                key={s.chats.join()}
                class={`spend-legend${picked?.key === `chat:${s.chats.join()}` ? ' open' : ''}`}
                title={`What ${s.label} spent, ${window === '7d' ? 'day' : 'hour'} by ${window === '7d' ? 'day' : 'hour'}`}
                onClick={() =>
                  pick(`chat:${s.chats.join()}`, () => ({
                    title: s.label,
                    rows: bs
                      .flatMap((b) =>
                        s.chats.flatMap((chat) => (b.cells.get(chat) ? [{ chat: timeline.chats[chat], cell: b.cells.get(chat)!, when: b.label }] : [])),
                      )
                      .reverse(),
                  }))
                }
              >
                <i style={{ background: colorOf(i) }} />
                {s.label}
                {s.chats.length === 1 && timeline.chats[s.chats[0]].running ? ' (running)' : ''}
              </button>
            ))}
          </div>
          <div class="metrics-columns" role="list">
            <span class="metrics-max">{formatValue(max, unit)}</span>
            {bs.map((b, i) => (
              <button
                key={b.from}
                role="listitem"
                class={`metrics-column${picked?.key === `at:${b.from}` ? ' open' : ''}`}
                title={tip(i)}
                aria-label={tip(i)}
                disabled={!totals[i]}
                onClick={() => pick(`at:${b.from}`, () => ({ title: b.label, rows: columnRows(b) }))}
              >
                <span class="stack">
                  {stacks[i].map((v, j) => (v > 0 ? <span key={j} style={{ height: `${(v / max) * 100}%`, background: colorOf(j) }} /> : null))}
                </span>
              </button>
            ))}
          </div>
          <div class="metrics-axis">
            {bs.map((b, i) => (
              <span key={b.from}>{i % every === 0 ? b.label : ''}</span>
            ))}
          </div>
        </div>
      )}
      {picked && (
        <div class="metrics-list" role="region" aria-label={picked.list.title}>
          <div class="metrics-list-head">
            <span>{picked.list.title}</span>
            <button class="metrics-icon" title="Close" aria-label="Close" onClick={() => setPicked(undefined)}>
              <i class="codicon codicon-close" />
            </button>
          </div>
          {picked.list.rows.map((r, i) => {
            const opensTicket = r.chat.agent && r.chat.ticket;
            return (
              <button
                key={i}
                class="metrics-item"
                title={opensTicket ? `Open ${r.chat.ticket}` : 'Open the chat'}
                onClick={() => (opensTicket ? props.openTicket(r.chat.ticket!) : props.openChat(r.chat.id, r.chat.cwd))}
              >
                <span class="label">{r.when ? `${r.when} · ${r.chat.label}` : r.chat.label}</span>
                <span class="detail">{detail(r.cell)}</span>
                <span class="value">{formatValue(r.cell.costUsd, 'usd')}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A cell's tokens by kind, turns and purposes. */
function detail(c: SpendCell): string {
  const t = (n: number) => formatValue(n, 'tokens');
  return `${t(c.input)} in · ${t(c.output)} out · ${t(c.cacheRead)} cache read · ${t(c.cacheWrite)} cache write · ${c.turns} turn${c.turns === 1 ? '' : 's'} · ${c.purposes.join(', ')}`;
}
