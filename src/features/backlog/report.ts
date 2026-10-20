/**
 * An agent's report in a ticket, read for the ticket's view: a summary of a few lines, what the agent needs from the
 * user (questions the user answers by clicking), and the details, which the ticket folds under the summary.
 *
 *   Summary, at most 3 lines.
 *
 *   Needs from you: the cache's storage.
 *
 *   ```question
 *   Which storage should the cache use?
 *   - Redis (recommended)
 *   - In memory
 *   ```
 *
 *   #### How to review
 *   …
 *
 * Reports in the older form (no "Needs from you" line, no verdict first) have no summary: they show whole.
 */

/** one or several choices; yes or no; or a free answer in a text box (a question with no choices). */
export type QuestionKind = 'one' | 'several' | 'yesno' | 'text';

export interface QuestionOption {
  text: string;
  recommended: boolean;
}

export interface Question {
  text: string;
  kind: QuestionKind;
  options: QuestionOption[];
}

export interface ReportParts {
  /** The summary (the lines before "Needs from you", or a verdict's first paragraph). Undefined: an older report. */
  summary?: string;
  /** The text after "Needs from you:" (what it's about); undefined when the report has no such line. */
  needs?: string;
  /** The report asks the user: a question, or a "Needs from you:" line with text. */
  asks: boolean;
  /** The questions the user answers by clicking (their blocks are taken out of the details). */
  questions: Question[];
  /** The rest of the report, after the summary. */
  details: string;
  /** The report waits for the user (asks, or ends with "Waiting for you."). */
  waiting: boolean;
}

const NEEDS = /^\s*[*_]*needs from you[*_]*\s*:[*_]*\s*(.*?)\s*$/i;
const VERDICT = /^\s*[*_]*verdict[*_]*\s*:/i;
const WAITING = /^[*_]*waiting for (you|the user|your answer)[.!]?[*_]*$/i;
const QUESTION_BLOCK = /^(`{3,}|~{3,})question[ \t]*\n([\s\S]*?)\n\1[ \t]*$/gm;
const KINDS: Record<string, QuestionKind> = { one: 'one', several: 'several', text: 'text', 'yes/no': 'yesno', 'yes or no': 'yesno', yesno: 'yesno' };

/** What agents are told about a report's shape: the summary, the Needs line and the questions. */
/** How an agent answers a comment in the ticket (BL-126): with a reply, whose first line names and links it. */
export const REPLY_RULE =
  'To answer a comment (or any entry) in the ticket, write your entry as a reply to it: its first line is "↩ [Reply to <its author>, <its date>](#<its anchor>)", then your answer. The anchor is its heading\'s date, time and author, lowercased, with other characters as "-" ("### 2026-10-20 16:04 · You" is `2026-10-20-1604-you`), and "-2", "-3"… for the second and later entries by that author in that minute. A report that answers nothing in particular is no reply.';

export const REPORT_FORMAT = [
  'Start each report with a summary of at most 3 lines, then a line "Needs from you: nothing", or "Needs from you:" and what you need. The details (how to review, findings) follow it: the ticket folds them under the summary, so keep the summary to what matters most. Where a diagram says it better than words (the steps of a plan, a flow, a structure), draw it in the report as a ```mermaid block.',
  'To ask the user, put the questions after that line, each in a block fenced with ```question: its first line is the question, then the choices as "- " lines, with the one you suggest marked "(recommended)". The user clicks an answer: one choice (the default), or "choose: several" for checkboxes. "Other…" is there for a free answer. With no choices, the question gets a text box; "choose: yes/no" gives Yes and No. Ask only what you can\'t decide yourself, and stop until you\'re resumed with the answer.',
  REPLY_RULE,
].join('\n\n');

/** Parses a report's Markdown (an agent's entry in a ticket's activity). */
export function parseReport(body: string): ReportParts {
  const text = body.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const at = lines.findIndex((l) => NEEDS.test(l));
  if (at >= 0) {
    const needs = NEEDS.exec(lines[at])![1];
    const { questions, rest } = takeQuestions(lines.slice(at + 1).join('\n'));
    const asks = (!!needs && !isNothing(needs)) || questions.length > 0;
    return {
      summary: lines.slice(0, at).join('\n').trim(),
      needs,
      asks,
      questions,
      details: rest.trim(),
      waiting: asks || lastLineWaits(lines),
    };
  }
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first >= 0 && VERDICT.test(lines[first])) {
    // A verdict starts the report: its summary is that line and the lines down to the next blank one.
    const end = lines.findIndex((l, i) => i > first && l.trim() === '');
    const cut = end < 0 ? lines.length : end;
    return {
      summary: lines.slice(first, cut).join('\n').trim(),
      asks: false,
      questions: [],
      details: lines.slice(cut).join('\n').trim(),
      waiting: lastLineWaits(lines),
    };
  }
  return { asks: false, questions: [], details: text.trim(), waiting: lastLineWaits(lines) };
}

const isNothing = (text: string) => /^nothing\.?$/i.test(text.trim());

function lastLineWaits(lines: string[]): boolean {
  const last = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  return !!last && WAITING.test(last);
}

/** The question blocks in a text, and the text without them (a block that isn't a question stays as it is). */
function takeQuestions(text: string): { questions: Question[]; rest: string } {
  const questions: Question[] = [];
  const rest = text.replace(QUESTION_BLOCK, (block: string, _fence: string, inner: string) => {
    const question = parseQuestion(inner);
    if (!question) return block;
    questions.push(question);
    return '';
  });
  return { questions, rest };
}

/** A question block: the question, the choices, and the kind of answer (the choices make it one; yes/no by default without any). */
export function parseQuestion(inner: string): Question | undefined {
  const text: string[] = [];
  const options: QuestionOption[] = [];
  let kind: QuestionKind | undefined;
  for (const raw of inner.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const choose = /^choose\s*:\s*(.+)$/i.exec(line);
    const option = /^[-*]\s+(.+)$/.exec(line);
    if (choose) kind = KINDS[choose[1].trim().toLowerCase()] ?? kind;
    else if (option) {
      const recommended = /\s*\(recommended\)\s*$/i.test(option[1]);
      options.push({ text: option[1].replace(/\s*\(recommended\)\s*$/i, '').trim(), recommended });
    } else if (!options.length) text.push(line);
  }
  const question = text.join(' ').trim();
  if (!question) return undefined;
  // No choices: a free answer (yes or no only when asked for).
  const resolved: QuestionKind = kind === 'yesno' ? 'yesno' : kind === 'text' || !options.length ? 'text' : (kind ?? 'one');
  const choices = resolved === 'text' ? [] : resolved === 'yesno' && !options.length ? [{ text: 'Yes', recommended: false }, { text: 'No', recommended: false }] : options;
  return { text: question, kind: resolved, options: choices };
}

/** The user's comment after a report that answers it: the first of theirs (undefined: not answered yet). */
export function reportAnswer(later: ReadonlyArray<{ author: string; body: string }>): string | undefined {
  return later.find((e) => e.author === 'You')?.body.trim();
}

/**
 * Each question's answer, as the comment that answered the report gave it: the whole comment for one question, else
 * each question's "**question** answer" paragraph.
 */
export function answersIn(questions: Question[], comment: string): string[] {
  if (questions.length === 1) return [comment.trim()];
  return questions.map((q) => {
    const head = `**${q.text}** `;
    const at = comment.indexOf(head);
    return at < 0 ? '' : comment.slice(at + head.length).split(/\n\n/)[0].trim();
  });
}

/** The answer a question was given, read back from its text (a choice's text, or what was written for Other). */
export function answerFromText(q: Question, text: string): Answer {
  if (q.kind === 'text') return { picked: [0], other: text };
  const parts = text.split(', ');
  const picked = q.options.flatMap((o, i) => (text === o.text || parts.includes(o.text) ? [i] : []));
  if (!picked.length && text) return { picked: [q.options.length], other: text };
  return { picked, other: '' };
}

/**
 * The user's answer to a question: the chosen options, by index (the index after the last option is "Other…"), and
 * what they wrote for Other.
 */
export interface Answer {
  picked: number[];
  other: string;
}

/** The answer a question starts with: its recommended choices (one, for a single choice); none otherwise. */
export function defaultAnswer(q: Question): Answer {
  if (!q.options.length) return { picked: [0], other: '' };
  const recommended = q.options.flatMap((o, i) => (o.recommended ? [i] : []));
  return { picked: q.kind === 'several' ? recommended : recommended.slice(0, 1), other: '' };
}

/** The answer after the user picks choice i: one choice replaces the last; several toggle. */
export function choose(q: Question, a: Answer, i: number): Answer {
  if (q.kind !== 'several') return { ...a, picked: [i] };
  return { ...a, picked: a.picked.includes(i) ? a.picked.filter((x) => x !== i) : [...a.picked, i] };
}

/** The answer as text (the chosen options' texts, then Other's), or '' while it's incomplete. */
export function answerOf(q: Question, a: Answer): string {
  const other = q.options.length;
  if (a.picked.includes(other) && !a.other.trim()) return '';
  const texts = [...new Set(a.picked)]
    .sort((x, y) => x - y)
    .flatMap((i) => (i === other ? [a.other.trim()] : q.options[i] ? [q.options[i].text] : []));
  return texts.join(', ');
}

/** The comment that posts the answers: the answer alone for one question, else each question with its answer. */
export function answerComment(answers: Array<{ question: Question; answer: string }>): string {
  if (answers.length === 1) return answers[0].answer;
  return answers.map(({ question, answer }) => `**${question.text}** ${answer}`).join('\n\n');
}
