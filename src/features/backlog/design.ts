/**
 * Mockups to pick before a ticket that changes the UI is built (BL-257). The agent draws two or three into the
 * description under **Mockups** and asks which to build, each choice of its question naming its picture:
 *
 *   **Mockups** (pick one in the activity):
 *
 *   ![A: Expand in the card's header](BL-7/mockup-a.svg) ![B: Expand under the summary](BL-7/mockup-b.svg)
 *
 *   ```question
 *   Which should I build?
 *   - ![A: Expand in the card's header](BL-7/mockup-a.svg) A (recommended)
 *   - ![B: Expand under the summary](BL-7/mockup-b.svg) B
 *   ```
 *
 * When you pick one, the description's Mockups becomes its **Design**: the chosen picture, the design the work is
 * built and reviewed against. The others stay in the folder, linked from the question's report.
 */
import {
  answerFromText,
  answersIn,
  parseReport,
  picksPicture,
  type QuestionOption,
} from './report';

const SECTION = { mockups: /^\s*(?:#{1,6}\s+|[*_]{2})mockups\b/i, design: /^\s*(?:#{1,6}\s+|[*_]{2})design\b/i };
const IMAGE = /!\[[^\]]*\]\([^)]*\)/;

/** The description's Mockups (or Design) section: its first line, and the end of the pictures (and what you said) under it. */
function sectionAt(lines: string[], kind: keyof typeof SECTION): { from: number; to: number } | undefined {
  const from = lines.findIndex((l) => SECTION[kind].test(l));
  if (from < 0) return undefined;
  let to = from + 1;
  while (to < lines.length && (!lines[to].trim() || IMAGE.test(lines[to]) || /^you said:/i.test(lines[to].trim()))) to++;
  while (to > from + 1 && !lines[to - 1].trim()) to--;
  return { from, to };
}

/** The description's Mockups, waiting for a pick, or else its Design (undefined: it has neither). */
export function designOf(description: string): string | undefined {
  const lines = description.replace(/\r\n?/g, '\n').split('\n');
  const at = sectionAt(lines, 'mockups') ?? sectionAt(lines, 'design');
  return at && lines.slice(at.from, at.to).join('\n');
}

/** The description has mockups waiting for a pick. */
export function hasMockups(description: string): boolean {
  return !!sectionAt(description.replace(/\r\n?/g, '\n').split('\n'), 'mockups');
}

/**
 * The description with its Mockups replaced by the Design: the chosen picture, and what you said with it. Undefined
 * when it has no Mockups (it was already replaced, or the agent put them elsewhere).
 */
export function withDesign(description: string, choice: Pick<QuestionOption, 'text' | 'image'>, said = ''): string | undefined {
  const lines = description.replace(/\r\n?/g, '\n').split('\n');
  const at = sectionAt(lines, 'mockups');
  if (!at || !choice.image) return undefined;
  const design = [
    `**Design** (you picked ${choice.text}; build and review against it):`,
    '',
    `![${choice.text}](${choice.image})`,
    ...(said.trim() ? ['', `You said: ${said.trim()}`] : []),
  ];
  return [...lines.slice(0, at.from), ...design, ...lines.slice(at.to)].join('\n');
}

/**
 * The mockup a comment picks: the latest entry before it (Flotilla's aside) that asks to pick a picture, if the
 * comment answers it with one of its pictures (not "None of these"). The others come with it, to link from the activity.
 */
export function pickedMockup(
  before: ReadonlyArray<{ author: string; body: string }>,
  comment: string,
): { choice: QuestionOption; others: QuestionOption[] } | undefined {
  // Flotilla's notes (the autopilot's, a move) can come after the question; a comment of yours already answered it.
  const last = before.filter((e) => e.author !== 'Flotilla').at(-1);
  if (!last || last.author === 'You') return undefined;
  const { questions } = parseReport(last.body);
  const answers = answersIn(questions, comment);
  for (const [i, q] of questions.entries()) {
    if (!picksPicture(q)) continue;
    const picked = answerFromText(q, answers[i] ?? '').picked;
    const choice = picked.length === 1 ? q.options[picked[0]] : undefined;
    if (choice?.image) return { choice, others: q.options.filter((o) => o !== choice && o.image) };
  }
  return undefined;
}

/**
 * What agents are told (the guide, the implementer's first prompt, Discuss): mockups first, for work that changes what
 * the user sees or clicks, so the look is agreed before it's built. folder: the ticket's folder, as the agent reaches it.
 */
export function mockupsRule(id: string, folder: string): string {
  return [
    `When a ticket changes something the user sees or clicks (a view, a panel, a button, a flow) and its description has no **Design** yet, design it with the user before you write code: draw 2–3 mockups of the change, put them in the description under a line "**Mockups** (pick one in the activity):", ask which to build, and stop until you're resumed with the answer. Text-only, internal or test-only work skips this.`,
    `Keep mockups small and cheap: SVG (or a static HTML page rendered to PNG), saved in ${folder} (mockup-a.svg, mockup-b.svg…), each showing the changed part in its real surroundings (the ticket page, the sidebar, the card) with the change marked. Under the Mockups line, put the pictures on one line, side by side, each with a one-line caption saying how it differs from the others as its text: ![A: Expand in the card's header](${id}/mockup-a.svg) ![B: Expand under the summary](${id}/mockup-b.svg).`,
    `Ask in a question whose choices name their pictures, so the user picks by clicking one: "- ![A: Expand in the card's header](${id}/mockup-a.svg) A (recommended)". It always offers "None of these…" with a text box: when that's the answer, draw a new round from what the user wrote. When the user picks one, the ticket replaces Mockups with **Design**: the picture picked (if it didn't, do that yourself, and add what the user said with it). Build to the Design, and show it in your demo: the reviewer checks the work against it.`,
  ].join(' ');
}

/** The reviewer checks the work against the Design the user picked (BL-257), next to the demo's check (BL-249). */
export const DESIGN_CHECK = `If the description has a **Design** (the mockup the user picked before the work was built), check the demo and the screenshots against it too: what's on screen should look like that mockup (the same parts, in the same places, the change where it marks it). Work that doesn't look like what the user picked is a change you request, naming what differs; small differences of colour, spacing or wording are taste: mention them, don't request them.`;
