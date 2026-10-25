/** The Metrics view (BL-158): what the host computes from the event log, and the webviews draw. */

/** The period shown: the last day, week or month (30 days), each compared with the one before. */
export type MetricsPeriod = 'day' | 'week' | 'month';

/** ratio: a number per another (criteria per $), with two decimals. */
export type MetricUnit = 'count' | 'minutes' | 'usd' | 'tokens' | 'percent' | 'ms' | 'ratio';

/** One thing a number or bar is made of: a ticket, a merge, an agent's run; its ticket opens from it. */
export interface MetricRow {
  label: string;
  detail?: string;
  ticket?: string;
  value?: number;
  unit?: MetricUnit;
}

/** A number of the period, the period before's, and what it's made of. */
export interface MetricNumber {
  id: string;
  label: string;
  value: number;
  previous: number;
  unit: MetricUnit;
  /** Lower is better (a time, a cost): a rise reads as worse. */
  lowerIsBetter?: boolean;
  rows: MetricRow[];
}

/** A bar: its label, its values (one per series, stacked) and what it's made of. */
export interface MetricBar {
  label: string;
  values: number[];
  rows: MetricRow[];
}

/**
 * A chart: columns over the period's days (hours, for a day), or rows, one per thing (a file, a role, a reason). With
 * no bars (or none above zero), it shows `empty`.
 */
export interface MetricChart {
  id: string;
  label: string;
  kind: 'columns' | 'rows';
  unit: MetricUnit;
  /** The stacked series' names (one, unnamed, for a plain chart). */
  series: string[];
  bars: MetricBar[];
  /** Why there's nothing to draw: "No merges this week". */
  empty: string;
  /** A line across the columns (the agent limit). */
  limit?: number;
}

export interface MetricSection {
  id: 'productivity' | 'flow' | 'merges' | 'agents' | 'cost' | 'you';
  title: string;
  numbers: MetricNumber[];
  charts: MetricChart[];
}

/** A chat that spent tokens (BL-202): an agent's (named by agent and ticket) or the user's own (by its title). */
export interface SpendChat {
  /** Its session. */
  id: string;
  label: string;
  ticket?: string;
  /** The folder it ran in: it opens there. */
  cwd?: string;
  /** An agent's chat: it opens its ticket. */
  agent?: true;
  /** It's running: its latest turns are counted at the price table's price. */
  running?: true;
}

/** What a chat spent in an hour. */
export interface SpendCell {
  /** Its chat, in the timeline's chats. */
  chat: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  turns: number;
  /** What its parts there were for (PURPOSE_LABEL's). */
  purposes: string[];
}

/** The chats' spend hour by hour over the last 7 days (BL-202): the hours with spend, oldest first. */
export interface SpendTimeline {
  chats: SpendChat[];
  hours: Array<{ at: string; cells: SpendCell[] }>;
}

export interface MetricsView {
  period: MetricsPeriod;
  /** The period's start and end (ISO). */
  from: string;
  to: string;
  sections: MetricSection[];
  /** How many events the view was counted from (all of the log). */
  events: number;
  /** The chats' spend over time, for the Spend over time chart (its own window: 6 hours to 7 days). */
  spend?: SpendTimeline;
}

/** From a Metrics webview (the sidebar's tool, or the editor tab). */
export type MetricsWebviewMessage =
  /** Count the view for a period (and again as events come in, until it's closed). */
  | { type: 'metrics'; period: MetricsPeriod }
  /** The sidebar left its Metrics tool: no need to count for it any more. */
  | { type: 'metricsClosed' }
  | { type: 'metricsOpen'; ticket: string }
  /** Open a chat (BL-202): in the worktree it ran in. */
  | { type: 'metricsOpenChat'; session: string; cwd?: string }
  | { type: 'metricsEditor'; period: MetricsPeriod };

/** To a Metrics webview. */
export type MetricsHostMessage = { type: 'metricsView'; view: MetricsView } | { type: 'metricsError'; message: string };
