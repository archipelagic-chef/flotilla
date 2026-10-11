/**
 * Claude's usage limits, as an agent run reports them: when a limit is hit, when it resets (so the agent can go on
 * then, by itself). Claude Code says it in its result or on stderr, in a few forms:
 *
 * - "Claude AI usage limit reached|1760572800" (the reset, in seconds since the epoch)
 * - "5-hour limit reached ∙ resets 3pm (Europe/Stockholm)", "You've hit your limit · resets 4:30am"
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
}

/** How long to wait when the reset isn't said. */
const WAIT_UNKNOWN_MS = { usage: 30 * 60_000, rate: 5 * 60_000, overloaded: 5 * 60_000 };
/** A little after the reset, so it's surely over. */
const MARGIN_MS = 60_000;

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
  const usage = /(usage limit|limit reached|hit your limit|limit will reset|out of (extra )?usage)/i.test(output);
  if (usage) {
    // "resets Oct 14, 9am (Zone)" or "resets 3pm (Zone)" / "resets at 4:30am".
    const dated = /resets?\s+(?:on\s+)?([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(output);
    const timed = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(output);
    let at: Date | undefined;
    if (dated && MONTHS.includes(dated[1].toLowerCase())) {
      const month = MONTHS.indexOf(dated[1].toLowerCase());
      // The coming one: a date before today is next year's.
      const year = month < now.getMonth() - 6 ? now.getFullYear() + 1 : now.getFullYear();
      at = zonedTime(year, month, Number(dated[2]), hour24(Number(dated[3]), dated[5]), Number(dated[4] ?? 0), dated[6]?.trim());
    } else if (timed) {
      const h = hour24(Number(timed[1]), timed[3]);
      const zone = timed[4]?.trim();
      at = zonedTime(now.getFullYear(), now.getMonth(), now.getDate(), h, Number(timed[2] ?? 0), zone);
      // The next time the clock shows it.
      for (let i = 0; at && at.getTime() <= now.getTime() && i < 2; i++) {
        at = zonedTime(now.getFullYear(), now.getMonth(), now.getDate() + i + 1, h, Number(timed[2] ?? 0), zone);
      }
    }
    if (at && at.getTime() > now.getTime() - MARGIN_MS) return { until: new Date(at.getTime() + MARGIN_MS), known: true, kind: 'usage' };
    return { until: new Date(now.getTime() + WAIT_UNKNOWN_MS.usage), known: false, kind: 'usage' };
  }
  if (/overloaded|\b529\b/i.test(output)) return { until: new Date(now.getTime() + WAIT_UNKNOWN_MS.overloaded), known: false, kind: 'overloaded' };
  if (/rate.?limit|\b429\b|too many requests/i.test(output)) return { until: new Date(now.getTime() + WAIT_UNKNOWN_MS.rate), known: false, kind: 'rate' };
  return undefined;
}
