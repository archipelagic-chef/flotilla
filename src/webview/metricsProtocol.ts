/** The Metrics view (BL-158): what the host computes from the event log, and the webviews draw. */

/** The period shown: the last day, week or month (30 days), each compared with the one before. */
export type MetricsPeriod = 'day' | 'week' | 'month';

export type MetricUnit = 'count' | 'minutes' | 'usd' | 'tokens' | 'percent' | 'ms';

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
  id: 'flow' | 'merges' | 'agents' | 'cost' | 'you';
  title: string;
  numbers: MetricNumber[];
  charts: MetricChart[];
}

export interface MetricsView {
  period: MetricsPeriod;
  /** The period's start and end (ISO). */
  from: string;
  to: string;
  sections: MetricSection[];
  /** How many events the view was counted from (all of the log). */
  events: number;
}

/** From a Metrics webview (the sidebar's tool, or the editor tab). */
export type MetricsWebviewMessage = { type: 'metrics'; period: MetricsPeriod } | { type: 'metricsOpen'; ticket: string } | { type: 'metricsEditor'; period: MetricsPeriod };

/** To a Metrics webview. */
export type MetricsHostMessage = { type: 'metricsView'; view: MetricsView } | { type: 'metricsError'; message: string };
