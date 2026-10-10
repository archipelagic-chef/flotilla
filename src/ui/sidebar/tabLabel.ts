/** Jira-style keys anywhere in the branch: "ABC-123", "feature/PROJ-42-login". */
const UPPER_KEY = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]{1,9}-\d+)(?![0-9])/;
/** Lowercase keys only at the start of a path segment: "abc-123-login", "feature/abc-123". */
const LOWER_KEY = /(?:^|\/)([a-z][a-z0-9]{1,9}-\d+)(?=$|[-_/.])/;
/** Issue numbers at the start of a segment: "123-fix-login", "feature/42_typo". */
const ISSUE_NUMBER = /(?:^|\/)#?(\d{1,7})(?=$|[-_/.])/;

/** Tabs stay narrow: about as wide as a ticket id like "AB-12345". */
const MAX_FALLBACK = 8;

/**
 * A short tab label for a branch: its ticket id (Jira key or issue number) when it has one, else the last part of
 * the branch, shortened. A custom pattern (setting flotilla.tabLabelPattern) wins: its first capture group, or the
 * whole match.
 */
export function tabLabel(branch: string, pattern?: string): string {
  if (pattern) {
    try {
      const m = new RegExp(pattern).exec(branch);
      const id = m?.[1] ?? m?.[0];
      if (id) return id;
    } catch {
      // invalid pattern: fall back to the built-in rules
    }
  }
  const detached = /^detached @ (\w+)$/.exec(branch);
  if (detached) return `@${detached[1].slice(0, 7)}`;
  const upper = UPPER_KEY.exec(branch);
  if (upper) return upper[1];
  const lower = LOWER_KEY.exec(branch);
  if (lower) return lower[1].toUpperCase();
  const issue = ISSUE_NUMBER.exec(branch);
  if (issue) return `#${issue[1]}`;
  const last = branch.split('/').filter(Boolean).pop() ?? branch;
  return last.length > MAX_FALLBACK ? `${last.slice(0, MAX_FALLBACK - 1)}…` : last;
}
