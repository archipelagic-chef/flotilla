/** The backlog's Scheduled lane (BL-283, was the Scheduled tool of BL-260): the scheduled tasks, when each runs next, what it waits for, its reports. */
export interface ScheduledTaskView {
  name: string;
  title: string;
  /** Its schedule in words ("Mondays at 06:00"); none when its file is wrong. */
  schedule?: string;
  /** What's wrong with its file (its .error): it doesn't run until that's fixed. */
  error?: string;
  /** When it runs next (ISO 8601); none: never again (a once: task that ran) or a wrong file. */
  next?: string;
  /** It's due now. */
  due?: boolean;
  /** What a due task waits for: "an agent is working", "all 3 agent slots are taken". */
  waits?: string;
  running?: boolean;
  /** Proposed by this agent: it runs only once accepted. */
  proposed?: string;
  /** It doesn't run on its schedule (paused: true in its file); Run Now still runs it. */
  paused?: boolean;
  /** Its reports' days, newest first. */
  reports: string[];
  /** The tickets each run proposed, by its report's day (BL-262). */
  proposals?: Record<string, RunTicket[]>;
}

/** A ticket a run proposed (BL-262): proposed is still in Needs you; dismissed is gone from the backlog. */
export interface RunTicket {
  id: string;
  title: string;
  state: 'accepted' | 'dismissed' | 'proposed';
}

export interface ScheduledView {
  tasks: ScheduledTaskView[];
  /** The folder the tasks' files are in. */
  dir: string;
}

export type ScheduledOp = 'run' | 'report' | 'edit' | 'accept' | 'dismiss' | 'pause' | 'resume' | 'new' | 'ticket';

/** From the Scheduled lane. */
export type ScheduledWebviewMessage =
  /** The tool is shown: send its view (and again as it changes, until it's closed). */
  | { type: 'scheduled' }
  | { type: 'scheduledClosed' }
  /** report: one of its reports (day), else its newest. new: New Scheduled Task (no name). ticket: a ticket a run proposed (name: its id). */
  | { type: 'scheduledAction'; op: ScheduledOp; name?: string; day?: string };

/** To the Scheduled lane. */
export type ScheduledHostMessage = { type: 'scheduledView'; view: ScheduledView };
