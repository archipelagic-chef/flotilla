/**
 * Claude's usage limits, as an agent run reports them: when a limit is hit, when it resets (so the agent can go on
 * then, by itself). Claude Code says it in its result or on stderr, in a few forms:
 *
 * - "Claude AI usage limit reached|1760572800" (the reset, in seconds since the epoch)
 * - "5-hour limit reached ∙ resets 3pm (Europe/Stockholm)", "You've hit your limit · resets 4:30am"
 * - "You've hit your session limit · resets 4am (UTC)", "You've hit your weekly limit · resets Oct 14, 9am"
 * - "Weekly limit reached ∙ resets Oct 14, 9am (Europe/Stockholm)"
 * - an API error: rate limited (429), or overloaded (529)
 */
export interface UsageLimit {
  /** When to go on. */
  until: Date;
  /** The reset time was said (not a guess). */
  known: boolean;
  /** What was hit: the plan's usage limit, or the API's rate limit or load (a short wait). */
  kind: 'usage' | 'rate' | 'overloaded';
  /** What Claude said, when the reset time wasn't understood (so a new wording is spotted). */
  said?: string;
}

/** How long to wait when the reset isn't said. */
const WAIT_UNKNOWN_MS = { usage: 30 * 60_000, rate: 5 * 60_000, overloaded: 5 * 60_000 };
/** Retries that keep failing wait longer each time, up to this... */
const RETRY_CAP_MS = 60 * 60_000;
/** ...and up to this once the wait has lasted an hour, so a lift isn't missed for long (BL-179). */
const RETRY_CAP_LONG_MS = 15 * 60_000;
const LONG_WAIT_MS = 60 * 60_000;
/** A little after the reset, so it's surely over. */
const MARGIN_MS = 60_000;
/** A reset time this recently past is the one just hit (the output read a little late), not tomorrow's. */
const JUST_PAST_MS = 5 * 60_000;
/** The longest text kept of what Claude said. */
const SAID_MAX = 200;

/** The plan's limits, in Claude Code's wordings. */
const USAGE = /usage limit|limit reached|hit your (?:[\w-]+ )?limit|\b(?:session|weekly|daily|5-hour|opus|sonnet) limit|limit will reset|out of (?:extra )?usage/i;
const OVERLOADED = /overloaded|\b529\b/i;
const RATE = /rate.?limit|\b429\b|too many requests/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A wall-clock time in a time zone, as a Date (the zone's offset found with Intl). Undefined if the zone is unknown. */
function zonedTime(y: number, mo: number, d: number, h: number, mi: number, zone: string | undefined): Date | undefined {
  const guess = new Date(y, mo, d, h, mi);
  if (!zone) return guess;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    // How the zone's clock differs from the local one at that moment, applied once (and once more across a DST change).
    let at = guess;
    for (let i = 0; i < 2; i++) {
      const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
      const shown = new Date(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
      at = new Date(at.getTime() + (guess.getTime() - shown.getTime()));
    }
    return at;
  } catch {
    return undefined;
  }
}

const hour24 = (h: number, ampm: string | undefined) => (!ampm ? h : ampm.toLowerCase() === 'pm' ? (h % 12) + 12 : h % 12);

/** The limit an agent's output says it hit, with when to go on; undefined if it didn't hit one. */
export function parseUsageLimit(output: string, now: Date): UsageLimit | undefined {
  const epoch = /limit reached\|(\d{9,13})/i.exec(output);
  if (epoch) {
    const n = Number(epoch[1]);
    return { until: new Date((n > 1e12 ? n : n * 1000) + MARGIN_MS), known: true, kind: 'usage' };
  }
  // A reset time said wins over anything else the output mentions (a 429, `rate_limit`): it's the plan's limit.
  const at = resetTime(output, now);
  const usage = USAGE.test(output);
  if (at && (usage || /limit/i.test(output))) return { until: new Date(Math.max(at.getTime(), now.getTime()) + MARGIN_MS), known: true, kind: 'usage' };
  const kind = usage ? 'usage' : OVERLOADED.test(output) ? 'overloaded' : RATE.test(output) ? 'rate' : undefined;
  if (!kind) return undefined;
  const said = saidText(output, kind === 'usage' ? USAGE : kind === 'overloaded' ? OVERLOADED : RATE);
  return { until: new Date(now.getTime() + WAIT_UNKNOWN_MS[kind]), known: false, kind, ...(said ? { said } : {}) };
}

/** The reset time the output says ("resets Oct 14, 9am (Zone)", "resets 3pm (Zone)", "resets at 4:30am"), the next one after `now`. */
function resetTime(output: string, now: Date): Date | undefined {
  const dated = /resets?\s+(?:on\s+)?([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(output);
  if (dated && MONTHS.includes(dated[1].toLowerCase())) {
    const month = MONTHS.indexOf(dated[1].toLowerCase());
    // The coming one: a date before today is next year's.
    const year = month < now.getMonth() - 6 ? now.getFullYear() + 1 : now.getFullYear();
    const at = zonedTime(year, month, Number(dated[2]), hour24(Number(dated[3]), dated[5]), Number(dated[4] ?? 0), dated[6]?.trim());
    return at && at.getTime() > now.getTime() - JUST_PAST_MS ? at : undefined;
  }
  const timed = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(output);
  if (!timed) return undefined;
  const h = hour24(Number(timed[1]), timed[3]);
  const zone = timed[4]?.trim();
  let at = zonedTime(now.getFullYear(), now.getMonth(), now.getDate() - 1, h, Number(timed[2] ?? 0), zone);
  // The next time the clock shows it (from yesterday's, as the zone's day may differ from the local one).
  for (let i = 0; at && at.getTime() <= now.getTime() - JUST_PAST_MS && i < 3; i++) {
    at = zonedTime(now.getFullYear(), now.getMonth(), now.getDate() + i, h, Number(timed[2] ?? 0), zone);
  }
  return at && at.getTime() > now.getTime() - JUST_PAST_MS ? at : undefined;
}

/** The line of the output that says the limit (a JSON line's result or error message), short. */
function saidText(output: string, wording: RegExp): string | undefined {
  const line = output.split(/\r?\n/).find((l) => wording.test(l));
  if (!line) return undefined;
  let text = line.trim();
  try {
    const j = JSON.parse(text) as { result?: unknown; error?: { message?: unknown } | unknown };
    const said = typeof j.result === 'string' ? j.result : typeof (j.error as { message?: unknown })?.message === 'string' ? (j.error as { message: string }).message : undefined;
    if (said && wording.test(said)) text = said;
  } catch {
    // Not JSON: the line as it is.
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > SAID_MAX ? `${text.slice(0, SAID_MAX - 1)}…` : text;
}

/**
 * How long to wait before the next try when the reset isn't said and `tries` tries have failed since: the first wait,
 * doubled each time (5, 10, 20, 40 minutes…), up to an hour; once it has `waited` an hour, up to 15 minutes.
 */
export function retryDelay(kind: UsageLimit['kind'], tries: number, waited = 0): number {
  const first = WAIT_UNKNOWN_MS[kind];
  return Math.min(first * 2 ** Math.max(0, Math.min(tries, 10)), waited >= LONG_WAIT_MS ? RETRY_CAP_LONG_MS : Math.max(first, RETRY_CAP_MS));
}
