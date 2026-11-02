/** The sidebar's Scheduled tool (BL-260): the scheduled tasks, when each runs next, what it waits for, its reports. */
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
  /** Its reports' days, newest first. */
  reports: string[];
}

export interface ScheduledView {
  tasks: ScheduledTaskView[];
  /** The folder the tasks' files are in. */
  dir: string;
}

export type ScheduledOp = 'run' | 'report' | 'edit' | 'accept' | 'dismiss' | 'folder';

/** From the Scheduled tool. */
export type ScheduledWebviewMessage =
  /** The tool is shown: send its view (and again as it changes, until it's closed). */
  | { type: 'scheduled' }
  | { type: 'scheduledClosed' }
  /** report: one of its reports (day), else its newest. folder: the schedules folder (no name). */
  | { type: 'scheduledAction'; op: ScheduledOp; name?: string; day?: string };

/** To the Scheduled tool. */
export type ScheduledHostMessage = { type: 'scheduledView'; view: ScheduledView };
