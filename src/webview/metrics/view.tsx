import { useEffect, useState } from "preact/hooks";
import type {
  MetricChart,
  MetricNumber,
  MetricRow,
  MetricsPeriod,
  MetricsView,
  MetricUnit,
} from "../metricsProtocol";
import "./metrics.css";

/**
 * The Metrics view (BL-158): the event log's numbers for a period, each compared with the period before. A number or
 * a bar opens what it's made of; a row there opens its ticket. Drawn the same in the sidebar's tool and the editor tab.
 */

const PERIODS: Array<{ id: MetricsPeriod; label: string; before: string }> = [
  { id: "day", label: "Day", before: "the day before" },
  { id: "week", label: "Week", before: "the week before" },
  { id: "month", label: "Month", before: "the month before" },
];

/** The theme's chart colors, in the order the series take them. */
const SERIES = ["blue", "orange", "purple", "green", "red", "yellow"].map(
  (c) => `var(--vscode-charts-${c})`,
);

export function formatValue(value: number, unit: MetricUnit): string {
  switch (unit) {
    case "minutes": {
      const m = Math.round(value);
      if (m < 60) return `${m}m`;
      const h = Math.floor(m / 60);
      if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
      return `${Math.round(h / 24)}d`;
    }
    case "usd":
      return value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`;
    case "tokens":
      return value >= 1e6
        ? `${(value / 1e6).toFixed(1)}M`
        : value >= 1000
          ? `${Math.round(value / 1000)}k`
          : String(Math.round(value));
    case "percent":
      return `${Math.round(value)}%`;
    case "ms":
      return value >= 1000
        ? `${(value / 1000).toFixed(1)} s`
        : `${Math.round(value)} ms`;
    case "count":
      return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
}

/** How a number moved since the period before: "▲ 2", worse or better. */
function change(n: MetricNumber): {
  text: string;
  tone: "up" | "down" | "same";
} {
  const d = n.value - n.previous;
  if (Math.abs(d) < 1e-9) return { text: "same", tone: "same" };
  const worse = n.lowerIsBetter ? d > 0 : d < 0;
  return {
    text: `${d > 0 ? "▲" : "▼"} ${formatValue(Math.abs(d), n.unit)}`,
    tone: worse ? "down" : "up",
  };
}

interface Opened {
  key: string;
  title: string;
  rows: readonly MetricRow[];
}

interface Props {
  view?: MetricsView;
  error?: string;
  period: MetricsPeriod;
  setPeriod(period: MetricsPeriod): void;
  openTicket(id: string): void;
  /** Opens the view in an editor tab (in the sidebar only). */
  openEditor?(): void;
  /** In the editor tab: the sections side by side when there's room. */
  wide?: boolean;
}

export function MetricsBody({
  view,
  error,
  period,
  setPeriod,
  openTicket,
  openEditor,
  wide,
}: Props) {
  const [opened, setOpened] = useState<Opened | undefined>();
  // What was opened belongs to the numbers it was opened from.
  useEffect(() => setOpened(undefined), [period]);
  const before = PERIODS.find((p) => p.id === period)!.before;
  const open = (o: Opened) =>
    setOpened((was) => (was?.key === o.key ? undefined : o));
  // A list opens under what it was opened from: a section's numbers, or a chart.
  const list = (prefix: string) =>
    opened?.key.startsWith(prefix) ? (
      <RowList
        opened={opened}
        close={() => setOpened(undefined)}
        openTicket={openTicket}
      />
    ) : null;
  return (
    <div class={`metrics${wide ? " wide" : ""}`}>
      <div class="metrics-bar">
        <div class="metrics-periods" role="radiogroup" aria-label="Period">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              role="radio"
              aria-checked={p.id === period}
              class={p.id === period ? "on" : ""}
              onClick={() => setPeriod(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
        {openEditor && (
          <button
            class="metrics-icon"
            title="Open in an editor tab"
            aria-label="Open in an editor tab"
            onClick={openEditor}
          >
            <i class="codicon codicon-link-external" />
          </button>
        )}
      </div>
      {error && (
        <p class="metrics-empty">The metrics couldn't be read: {error}</p>
      )}
      {!view && !error && <p class="metrics-empty">Counting…</p>}
      {view && !view.events && (
        <p class="metrics-empty">
          No events recorded yet: Flotilla records them as tickets, agents and
          merges go.
        </p>
      )}
      <div class="metrics-sections">
        {view &&
          view.sections.map((s) => (
            <section key={s.id} class="metrics-section" aria-label={s.title}>
              <h3>{s.title}</h3>
              <div class="metrics-numbers">
                {s.numbers.map((n) => {
                  const c = change(n);
                  const key = `${s.id}.n.${n.id}`;
                  return (
                    <button
                      key={n.id}
                      class={`metrics-number${opened?.key === key ? " open" : ""}`}
                      title={`${n.label}: ${formatValue(n.previous, n.unit)} ${before}`}
                      onClick={() =>
                        open({ key, title: n.label, rows: n.rows })
                      }
                    >
                      <span class="value">{formatValue(n.value, n.unit)}</span>
                      <span class="label">{n.label}</span>
                      <span class={`change ${c.tone}`}>
                        {c.text} <span class="vs">vs {before}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {list(`${s.id}.n.`)}
              {s.charts.map((c) => (
                <div key={c.id} class="metrics-chart">
                  <h4>{c.label}</h4>
                  <Chart
                    chart={c}
                    openKey={opened?.key}
                    keyOf={(i) => `${s.id}.c.${c.id}:${i}`}
                    open={(i) =>
                      open({
                        key: `${s.id}.c.${c.id}:${i}`,
                        title: `${c.label}: ${c.bars[i].label}`,
                        rows: c.bars[i].rows,
                      })
                    }
                  />
                  {list(`${s.id}.c.${c.id}:`)}
                </div>
              ))}
            </section>
          ))}
      </div>
    </div>
  );
}

function Chart({
  chart,
  open,
  openKey,
  keyOf,
}: {
  chart: MetricChart;
  open(i: number): void;
  openKey?: string;
  keyOf(i: number): string;
}) {
  const totals = chart.bars.map((b) => b.values.reduce((a, x) => a + x, 0));
  const max = Math.max(...totals, chart.limit ?? 0, 0);
  if (!totals.some((t) => t > 0))
    return <p class="metrics-empty">{chart.empty}</p>;
  const isOpen = (i: number) => openKey === keyOf(i);
  const legend =
    chart.series.length > 1 ? (
      <div class="metrics-legend">
        {chart.series.map((name, i) => (
          <span key={name}>
            <i style={{ background: SERIES[i % SERIES.length] }} />
            {name}
          </span>
        ))}
      </div>
    ) : null;
  const tip = (i: number) =>
    `${chart.bars[i].label}: ${chart.series.length > 1 ? chart.bars[i].values.map((v, j) => `${chart.series[j]} ${formatValue(v, chart.unit)}`).join(", ") : formatValue(totals[i], chart.unit)}`;

  if (chart.kind === "rows") {
    return (
      <div class="metrics-rows">
        {chart.bars.map((b, i) => (
          <button
            key={b.label}
            class={`metrics-row${isOpen(i) ? " open" : ""}`}
            title={tip(i)}
            disabled={!b.rows.length}
            onClick={() => open(i)}
          >
            <span class="label">{b.label}</span>
            <span class="track">
              <span
                class="fill"
                style={{
                  width: `${max ? (totals[i] / max) * 100 : 0}%`,
                  background: SERIES[0],
                }}
              />
            </span>
            <span class="value">{formatValue(totals[i], chart.unit)}</span>
          </button>
        ))}
      </div>
    );
  }
  // Columns: a label under every few of them, so they don't crowd at the sidebar's width.
  const every = Math.ceil(chart.bars.length / 8);
  return (
    <div>
      {legend}
      <div class="metrics-columns" role="list">
        <span class="metrics-max">{formatValue(max, chart.unit)}</span>
        {chart.limit !== undefined && max > 0 && (
          <span
            class="metrics-limit"
            style={{ bottom: `${(chart.limit / max) * 100}%` }}
            title={`Limit: ${chart.limit}`}
          />
        )}
        {chart.bars.map((b, i) => (
          <button
            key={i}
            role="listitem"
            class={`metrics-column${isOpen(i) ? " open" : ""}`}
            title={tip(i)}
            aria-label={tip(i)}
            disabled={!b.rows.length}
            onClick={() => open(i)}
          >
            <span class="stack">
              {b.values.map((v, j) =>
                v > 0 ? (
                  <span
                    key={j}
                    style={{
                      height: `${(v / max) * 100}%`,
                      background: SERIES[j % SERIES.length],
                    }}
                  />
                ) : null,
              )}
            </span>
          </button>
        ))}
      </div>
      <div class="metrics-axis">
        {chart.bars.map((b, i) => (
          <span key={i}>{i % every === 0 ? b.label : ""}</span>
        ))}
      </div>
    </div>
  );
}

function RowList({
  opened,
  close,
  openTicket,
}: {
  opened: Opened;
  close(): void;
  openTicket(id: string): void;
}) {
  return (
    <div class="metrics-list" role="region" aria-label={opened.title}>
      <div class="metrics-list-head">
        <span>{opened.title}</span>
        <button
          class="metrics-icon"
          title="Close"
          aria-label="Close"
          onClick={close}
        >
          <i class="codicon codicon-close" />
        </button>
      </div>
      {!opened.rows.length && <p class="metrics-empty">Nothing in it.</p>}
      {opened.rows.slice(0, 200).map((r, i) => (
        <button
          key={i}
          class="metrics-item"
          disabled={!r.ticket}
          title={r.ticket ? `Open ${r.ticket}` : undefined}
          onClick={() => r.ticket && openTicket(r.ticket)}
        >
          <span class="label">{r.label}</span>
          {r.detail && <span class="detail">{r.detail}</span>}
          {r.value !== undefined && r.unit && (
            <span class="value">{formatValue(r.value, r.unit)}</span>
          )}
        </button>
      ))}
      {opened.rows.length > 200 && (
        <p class="metrics-empty">and {opened.rows.length - 200} more</p>
      )}
    </div>
  );
}
