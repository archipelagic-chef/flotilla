// Seeds the playground (.playground, made by playground.mjs) with a backlog and worktrees in every state Flotilla
// handles, so they can be seen without waiting for agents to get there: To Do (proposed, accepted), an epic with parts,
// In Progress with a question, In Review (run blocks of each kind; none; approved; stopped; paused on a usage limit) and
// Done. The unit test (tests/unit/features/playgroundSeed.test.ts) seeds a temporary repo with this and checks what it
// reads as, so change the two together.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as gifencModule from 'gifenc';
import { tagGif } from './demo-kit.mjs';
// The app's own code (src/features/backlog/seedKit.ts, built by npm run build), so the seed writes what the app reads.
import {
  actionable,
  descriptionHash,
  entryDate,
  entryKey,
  formatTicket,
} from '../dist/playground-seed-kit.mjs';

// Node loads gifenc's CommonJS build (its functions on the default export), as demo-kit.mjs does.
const { GIFEncoder, quantize, applyPalette } = gifencModule.default?.GIFEncoder ? gifencModule.default : gifencModule;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const UUID = '6f1d2c3a-0b7e-4d5a-9c8e-1a2b3c4d5e6f';
/** A paused agent goes on by itself when its limit resets: far ahead, so the playground's stays paused. */
const PAUSED_UNTIL = '2099-01-01T09:00:00.000Z';

const SIDEBAR = [
  '// The sidebar list: a refresh keeps the scroll position, unless the list is empty.',
  'export function refresh(list, scrollTop) {',
  '  return { list, scrollTop: list.length ? scrollTop : 0 };',
  '}',
  '',
].join('\n');

const CARD_V1 = [
  '// A review card: the ticket title.',
  'export function card(ticket) {',
  "  return '<article class=\"card\">' + ticket.title + '</article>';",
  '}',
  '',
].join('\n');

const CARD_V2 = [
  '// A review card: the ticket title, and a Run button when the ticket has a run block.',
  'export function card(ticket) {',
  "  return '<article class=\"card\">' + ticket.title + (ticket.run ? '<button>Run</button>' : '') + '</article>';",
  '}',
  '',
].join('\n');

/**
 * The scenarios, in backlog order. `ago`: minutes before the seeding; `daysAgo`: when the item was made. Branches: a
 * `from: 'first'` item starts from the first commit, and main moves on past it (so it's one behind); the others start
 * from main. A review's `handled` is every report the loop acts on, so nothing starts by itself when the playground opens.
 */
const TICKETS = [
  {
    id: 'BL-1',
    title: 'Show a run button on review cards',
    status: 'review',
    priority: 'high',
    daysAgo: 6,
    branch: 'feature/BL-1-show-a-run-button-on-review-cards',
    description: [
      "**When it's done:** A review card shows a Run button when its ticket has a run block, so you try the work from the",
      'board, without opening the ticket.',
      '',
      "**Why:** to try a ticket's work today, you open the ticket, find its last report and copy its commands into a",
      'terminal. The card knows the ticket, but not its run block.',
      '',
      'Acceptance criteria:',
      "- [ ] The card's Run button runs the ticket's run block: the last one its reports have.",
      '- [ ] Each kind of run block (shell, launch, task, open a URL, open a file) does what it says.',
    ].join('\n'),
    review: { round: 1, state: 'yours', implementer: 'Nova-7', reviewer: '' },
    activity: [
      { ago: 150, author: 'Agent Nova-7', body: "Started on it. The card reads the ticket's run block, the last one its reports have." },
      {
        ago: 20,
        author: 'Agent Nova-7',
        body: [
          "Done: the card gets a Run button, and the ticket's run is the last run block of its reports.",
          '',
          'What changed:',
          '',
          '- `src/card.js` renders the button; a card without a run block has none.',
          '- Launch and task blocks name a configuration or task of `.vscode/`, which the playground has.',
          '',
          '#### How to review',
          '',
          '1. [src/card.js:2-4](src/card.js#L2-L4): the card and its Run button.',
          '',
          "Try it, one block of each kind (the last one is the ticket's run):",
          '',
          '```run Check the card',
          'node --check src/card.js',
          '```',
          '',
          '```run launch Run App',
          '```',
          '',
          '```run task test',
          '```',
          '',
          '```run open http://127.0.0.1:5173',
          '```',
          '',
          '```run open src/card.js',
          '```',
          '',
          'Ready for review.',
        ].join('\n'),
      },
    ],
    commits: [
      { message: 'BL-1: Add the card module', files: { 'src/card.js': CARD_V1 } },
      { message: 'BL-1: Show the run button on review cards', files: { 'src/card.js': CARD_V2 } },
    ],
  },
  {
    id: 'BL-2',
    title: "Keep the sidebar's scroll on refresh",
    status: 'review',
    daysAgo: 9,
    from: 'first',
    branch: 'feature/BL-2-keep-the-sidebar-s-scroll-on-refresh',
    description: [
      'The sidebar keeps its scroll position when a refresh brings the same list back.',
      '',
      '- [ ] Scrolling stays put on a refresh when the list is unchanged.',
      '- [ ] An empty list still scrolls to the top.',
      '',
      // Its agent, when sent back, works long enough to be seen in the backlog's count (demos/agent-count.json).
      'fake: wait 60s',
    ].join('\n'),
    review: { round: 1, state: 'yours', implementer: 'Ada-1', reviewer: '' },
    activity: [
      { ago: 300, author: 'Agent Ada-1', body: 'Started on it. The list keeps its scroll position when it refreshes.' },
      {
        ago: 45,
        author: 'Agent Ada-1',
        body: [
          'Done: a refresh keeps the scroll position, unless the list is empty.',
          '',
          '#### How to review',
          '',
          '1. [src/sidebar.js:2-5](src/sidebar.js#L2-L5): the refresh and what it keeps.',
          '',
          'Nothing to run: the change only shows in the sidebar, so reading the diff is enough.',
          '',
          'Ready for review.',
        ].join('\n'),
      },
    ],
    commits: [{ message: "BL-2: Keep the sidebar's scroll position on refresh", files: { 'src/sidebar.js': SIDEBAR } }],
  },
  {
    id: 'BL-3',
    title: 'Keep chats when a window reloads',
    status: 'doing',
    priority: 'medium',
    daysAgo: 12,
    branch: 'feature/BL-3-keep-chats-when-a-window-reloads',
    description: [
      "A window that reloads finds its agents' chats again: the chat of a worktree is saved with it.",
      '',
      '- [ ] Reloading the window shows the same chat for each worktree.',
      '- [ ] Uncommitted changes in a worktree are left alone.',
    ].join('\n'),
    review: { round: 0, state: 'asking', implementer: 'Vega-2', reviewer: '' },
    activity: [
      { ago: 120, author: 'Agent Vega-2', body: "Started on it. A worktree's chat is saved with the worktree, so a reload can find it." },
      {
        ago: 40,
        author: 'Agent Vega-2',
        body: [
          'Progress: the chat id is saved, and a reload finds it again (two commits on the branch).',
          '',
          'One question before I go on: when a worktree has changes that are not committed, should a reload keep them as they are, or ask first?',
          '',
          'Waiting for you.',
        ].join('\n'),
      },
    ],
    commits: [
      {
        message: "BL-3: Save the chat's id with its worktree",
        files: { 'src/chats.js': 'export function saveChat(store, worktree, id) {\n  store[worktree] = id;\n  return store;\n}\n' },
      },
      {
        message: 'BL-3: Find the chat again after a reload',
        files: {
          'src/chats.js':
            'export function saveChat(store, worktree, id) {\n  store[worktree] = id;\n  return store;\n}\n\nexport function chatOf(store, worktree) {\n  return store[worktree];\n}\n',
        },
      },
    ],
    // Changes not committed: staged, unstaged and untracked.
    dirty: {
      staged: { 'src/chat-store.js': "// Chats saved to the workspace's state.\nexport const KEY = 'flotilla.chats';\n" },
      unstaged: {
        'src/chats.js':
          'export function saveChat(store, worktree, id) {\n  store[worktree] = id;\n  return store;\n}\n\nexport function chatOf(store, worktree) {\n  return store[worktree];\n}\n\n// TODO: read the store on start.\n',
      },
      untracked: { 'notes.txt': 'Reload: check the chat id is the same after it.\n' },
    },
  },
  {
    id: 'BL-4',
    title: 'Sort the backlog by priority',
    status: 'todo',
    daysAgo: 2,
    proposed: { by: 'Nova-7' },
    description: [
      "Add a Sort by priority option to the backlog's menu. The order set by hand stays the default.",
      '',
      '- [ ] Urgent first, then high, medium and low, then the items with no priority.',
      '- [ ] Dragging an item still sets its place in the order.',
    ].join('\n'),
    activity: [
      {
        ago: 240,
        author: 'Agent Nova-7',
        body: "Proposed this ticket.\n\nThe backlog's order is set by hand. A sort by priority would sit next to it, not replace it.",
      },
    ],
  },
  {
    id: 'BL-5',
    title: 'Start a ticket from the keyboard',
    status: 'todo',
    daysAgo: 3,
    // A linked issue, with no integration connected: its chip shows, and Unlink works offline (BL-118's demo).
    links: [{ id: 'GH-7', source: 'github', url: 'https://github.com/example/playground/issues/7', title: 'Start tickets without the mouse' }],
    description: [
      'A keyboard shortcut starts the selected ticket in its own worktree, as the Start button does.',
      '',
      '- [ ] The shortcut is shown in the backlog menu.',
      '- [ ] It does nothing on a ticket that is already in progress.',
    ].join('\n'),
    activity: [
      { ago: 200, author: 'Agent Pip-3', body: 'Proposed this ticket.' },
      { ago: 180, author: 'Flotilla', body: 'You accepted it into the backlog.' },
    ],
  },
  {
    id: 'BL-6',
    title: 'Attach any file to a ticket',
    status: 'doing',
    daysAgo: 14,
    description: [
      'Tickets take files of any kind, not only images, in parts.',
      '',
      '- [ ] Every part below is done.',
      '- [ ] A file that is too big says so.',
    ].join('\n'),
    activity: [
      { ago: 400, author: 'Flotilla', body: 'You moved it from **To Do** to **In Progress**.' },
      { ago: 390, author: 'You', body: 'Drag and drop first, then the file list.' },
    ],
  },
  {
    id: 'BL-7',
    title: 'Attach files by drag and drop',
    status: 'done',
    parent: 'BL-6',
    daysAgo: 14,
    description: [
      "Drop a file on a ticket's description to attach it.",
      '',
      '- [ ] The file is saved in the ticket folder and linked in the Markdown.',
      '- [ ] Dropping several files links each one.',
    ].join('\n'),
    activity: [
      { ago: 600, author: 'Flotilla', body: 'You made it part of BL-6.' },
      { ago: 60, author: 'Flotilla', body: 'You moved it from **In Review** to **Done**.' },
    ],
  },
  {
    id: 'BL-8',
    title: 'List attached files in the activity',
    status: 'todo',
    parent: 'BL-6',
    daysAgo: 14,
    description: [
      "Attached files show in the ticket's activity, with their size.",
      '',
      '- [ ] The size is shown next to each file.',
      '- [ ] A removed file is marked as missing.',
    ].join('\n'),
    activity: [{ ago: 600, author: 'Flotilla', body: 'You made it part of BL-6.' }],
  },
  {
    id: 'BL-9',
    title: 'Show the usage limit in the status bar',
    status: 'done',
    priority: 'low',
    daysAgo: 20,
    description:
      "The status bar shows Claude's usage limit, and when it resets.\n\n- [ ] Shown while the limit is reached.\n- [ ] Hidden when there is no limit.",
    activity: [
      {
        ago: 1500,
        author: 'Agent Pip-3',
        body: [
          'Done: the status bar shows the limit, and counts down to its reset.',
          'Needs from you: nothing',
          '',
          '![The status bar, counting down to the reset](BL-9/limit.mp4)',
        ].join('\n'),
      },
      { ago: 1440, author: 'Flotilla', body: 'You moved it from **In Review** to **Done**.' },
    ],
    // A video (BL-134's demo): it plays when clicked, in Attachments and in the activity.
    files: { 'limit.mp4': fs.readFileSync(new URL('./playground-media/limit.mp4', import.meta.url)) },
  },
  {
    id: 'BL-10',
    title: 'Remember the last open ticket',
    status: 'review',
    daysAgo: 5,
    branch: 'feature/BL-10-remember-the-last-open-ticket',
    description: [
      'Each window remembers the last ticket it opened, and opens it again on start.',
      '',
      '- [ ] It opens once on start, not on every refresh.',
      '- [ ] Nothing opens in a window with no backlog.',
    ].join('\n'),
    review: { round: 1, state: 'approved', reviewer: 'Iris-4', implementer: 'Pip-3' },
    activity: [
      {
        ago: 150,
        author: 'Agent Pip-3',
        body: 'A first try: the ticket opens again, but on every refresh.\n\n![It opens on every refresh](BL-10/demo-first.gif)',
      },
      {
        ago: 90,
        author: 'Agent Pip-3',
        body: [
          'Done: the last ticket opened in a window is remembered, and opens again on start.',
          '',
          '#### How to review',
          '',
          '1. [src/last.js:2-4](src/last.js#L2-L4): where the id is remembered.',
          '',
          'How a window opens:',
          '```mermaid',
          'flowchart LR',
          '  A[Window starts] --> B{A ticket remembered?}',
          '  B -- yes --> C[Open that ticket]',
          '  B -- no --> D[Open the backlog]',
          '```',
          '',
          'Before, a new window opens on the backlog:',
          '',
          '![A new window, on the backlog](BL-10/before.svg)',
          '',
          'After, it opens the last ticket again:',
          '',
          '![The last ticket, open again](BL-10/after.svg)',
          '',
          'Try it:',
          '',
          '```run Check the file',
          'node --check src/last.js',
          '```',
          '',
          'It working (the Demo section shows it, BL-135):',
          '',
          '![The last ticket opens again on start](BL-10/demo.gif)',
          '',
          '```run demo open-ticket',
          'npm run demo -- play open-ticket',
          '```',
          '',
          'Ready for review.',
        ].join('\n'),
      },
      { ago: 30, author: 'Agent Iris-4', body: 'Reviewed it. It does what the ticket asks, and the check in the report passes.\n\nVerdict: approved' },
    ],
    commits: [
      {
        message: 'BL-10: Remember the last open ticket',
        files: {
          'src/last.js': '// The last ticket opened in this window.\nexport function rememberTicket(state, id) {\n  return { ...state, lastTicket: id };\n}\n',
        },
      },
    ],
    // Its folder (BL-110's Attachments): the report's pictures, and a sketch nothing references.
    files: {
      'before.svg': picture('#3a6ea5', 'Backlog'),
      'after.svg': picture('#4c9a52', 'BL-10 Remember the last open ticket'),
      'sketch.svg': picture('#a5763a', 'Sketch'),
      // Its demos (BL-135's Demo section): the latest, and the first try's.
      // Recorded from open-ticket, as the recorder notes it (BL-111): it goes with that block, as one unit.
      'demo.gif': tagGif(recording('#4c9a52', 12), 'open-ticket'),
      'demo-first.gif': recording('#a5763a', 8),
    },
  },
  {
    id: 'BL-11',
    title: 'Keep the filter on worktree removal',
    status: 'review',
    daysAgo: 7,
    branch: 'feature/BL-11-keep-the-filter-on-worktree-removal',
    description: [
      "The sidebar's filter stays when a worktree is removed, unless it only shows that worktree.",
      '',
      '- [ ] A filter on another worktree stays.',
      '- [ ] A test covers removing a worktree.',
    ].join('\n'),
    review: {
      round: 2,
      state: 'stopped',
      reviewer: 'Rex-6',
      implementer: 'Juno-2',
      reason: 'the reviewer gave no verdict.',
      stop: {
        kind: 'no-verdict',
        task: {
          prompt: 'Add the test for removing a worktree, as the reviewer asked, then report.',
          why: 'the reviewer asked for a test, and gave no verdict',
        },
      },
    },
    activity: [
      {
        ago: 200,
        author: 'Agent Juno-2',
        body: [
          'Done: the filter stays when its worktree is removed, unless it only shows that worktree.',
          '',
          '#### How to review',
          '',
          '1. [src/filter.js:2-4](src/filter.js#L2-L4): the rule for the filter when a worktree goes.',
          '',
          "Nothing to run yet: the test for removal is still missing (see the reviewer's report).",
          '',
          'Ready for review.',
        ].join('\n'),
      },
      { ago: 100, author: 'Agent Rex-6', body: 'Looked at it. The rule is right, but nothing tests a removal yet. Please add the test before this goes on.' },
      { ago: 95, author: 'Flotilla', body: 'The review stopped: the reviewer gave no verdict.' },
    ],
    commits: [
      {
        message: 'BL-11: Keep the filter on worktree removal',
        files: {
          'src/filter.js':
            '// The sidebar filter: kept when a worktree goes, unless it only shows that worktree.\nexport function afterRemoval(filter, removed) {\n  return filter.worktree === removed ? { ...filter, worktree: undefined } : filter;\n}\n',
        },
      },
    ],
    dirty: { untracked: { 'scratch.txt': 'removal test: create a worktree, remove it, check the filter.\n' } },
  },
  {
    id: 'BL-12',
    title: 'Warn on a big diff before review',
    status: 'review',
    daysAgo: 4,
    branch: 'feature/BL-12-warn-on-a-big-diff-before-review',
    description: [
      'A review of a diff over 800 lines warns first, with the line count, and asks whether to go on.',
      '',
      '- [ ] The warning gives the line count.',
      '- [ ] Going on starts the review as usual.',
    ].join('\n'),
    review: {
      round: 1,
      state: 'paused',
      reviewer: 'Ziggy-5',
      implementer: 'Ada-1',
      paused: { until: PAUSED_UNTIL, known: true, phase: 'review', session: UUID, agent: 'Ziggy-5', resume: 'reviewing' },
    },
    activity: [
      {
        ago: 70,
        author: 'Agent Ada-1',
        body: [
          'Done: a review of a diff over 800 lines warns first, with the line count.',
          '',
          '#### How to review',
          '',
          '1. [src/diff-size.js:2-4](src/diff-size.js#L2-L4): the limit and the check.',
          '',
          'Try it:',
          '',
          '```run Check the diff size',
          'node --check src/diff-size.js',
          '```',
          '',
          'Ready for review.',
        ].join('\n'),
      },
      { ago: 20, author: 'Flotilla', body: "Ziggy-5 stopped on Claude's usage limit. It goes on by itself when it resets." },
    ],
    commits: [
      {
        message: 'BL-12: Warn on a big diff before review',
        files: {
          'src/diff-size.js':
            '// How many lines a review may look at before it warns.\nexport function warnsAbout(lines, limit = 800) {\n  return lines > limit;\n}\n',
        },
      },
    ],
  },
  {
    id: 'BL-13',
    title: 'Say hi in the greeting',
    status: 'review',
    daysAgo: 3,
    branch: 'feature/BL-13-say-hi-in-the-greeting',
    // Pushed to the playground's origin (a local bare repository with a GitHub-like path): its ticket shows its CI from the fake GitHub (BL-106).
    published: true,
    // Its merge's agent (Fix with Agent) works long enough to be paused by Pause All (demos/pause-all-merge.json).
    description: 'The greeting says hi: "Hi Ada!" instead of "Hello, Ada!".\n\n- [ ] The CLI and the server say hi.\n\nfake: wait 30s',
    review: { round: 1, state: 'approved', reviewer: 'Iris-4', implementer: 'Vega-2' },
    activity: [
      {
        ago: 60,
        author: 'Agent Vega-2',
        body: 'Done: the greeting says hi.\n\n#### How to review\n\n1. [src/greeting.js:2-4](src/greeting.js#L2-L4): the new wording.\n\nReady for review.',
      },
      { ago: 25, author: 'Agent Iris-4', body: 'Reviewed it. The greeting says hi, as the ticket asks.\n\nVerdict: approved' },
    ],
    // It merges cleanly, but the tests still expect the comma: the merge's checks fail (BL-65's demo).
    commits: [
      {
        message: 'BL-13: Say hi in the greeting',
        files: { 'src/greeting.js': "// The one place the greeting's wording lives.\nexport function greet(name = 'world') {\n  return `Hi ${name}!`;\n}\n" },
      },
    ],
  },
  {
    id: 'BL-14',
    title: 'Show the backlog as a board',
    status: 'done',
    daysAgo: 4,
    description:
      'The backlog shows as a board: a column per status, cards moved by dragging.\n\n- [ ] Dragging a card moves it.\n- [ ] The board remembers its scroll.',
    review: { round: 1, state: 'approved', reviewer: 'Iris-4', implementer: 'Nova-7' },
    // Reports that lead with their pictures and diagrams (BL-114's demo): the older ones fold, each with its strip.
    activity: [
      {
        ago: 300,
        author: 'Agent Nova-7',
        body: [
          'Plan: a column per status, drawn from backlog.json; dragging writes the new status through the inbox.',
          'Needs from you: nothing',
          '',
          '```mermaid',
          'flowchart LR',
          '  B[backlog.json] --> C[columns] --> D[drag a card] --> I[inbox] --> B',
          '```',
        ].join('\n'),
      },
      {
        ago: 200,
        author: 'Agent Nova-7',
        body: [
          'The board shows the columns; dragging a card moves it.',
          'Needs from you: nothing',
          '',
          '#### How to review',
          '',
          'The list before, and the board now:',
          '',
          '![The list, before](BL-14/list.svg) ![The board, after](BL-14/board.svg)',
          '',
          'Ready for review.',
        ].join('\n'),
      },
      {
        ago: 120,
        author: 'Agent Iris-4',
        body: [
          'Verdict: approved',
          'The board does what the ticket asks; its scroll stays.',
          '',
          '![The board, scrolled and refreshed](BL-14/scrolled.svg)',
          '',
          'Ran the tests: all pass.',
        ].join('\n'),
      },
      {
        ago: 60,
        author: 'Agent Nova-7',
        body: [
          'Done: the board is merged, and the list stays a click away.',
          'Needs from you: nothing',
          '',
          '#### What changed',
          '',
          '```mermaid',
          'flowchart TB',
          '  V[Backlog view] --> L[List]',
          '  V --> Bo[Board]',
          '```',
          '',
          '![The toggle between them](BL-14/toggle.svg)',
          '',
          'Nothing left open.',
        ].join('\n'),
      },
      { ago: 30, author: 'Flotilla', body: 'You moved it from **In Review** to **Done**.' },
    ],
    files: {
      'list.svg': picture('#3a6ea5', 'Backlog: a list'),
      'board.svg': picture('#4c9a52', 'Backlog: To Do · In Progress · Done'),
      'scrolled.svg': picture('#7a4ca5', 'The board, scrolled'),
      'toggle.svg': picture('#a5763a', 'List | Board'),
    },
  },
  {
    id: 'BL-15',
    title: 'Remember the last open tab',
    status: 'review',
    daysAgo: 2,
    branch: 'feature/BL-15-remember-the-last-open-tab',
    // It writes src/last.js as BL-10 does: queued behind it, it conflicts with it in the merge train (BL-146's demo).
    description: [
      'A window remembers which tab of a ticket was open last, and opens it again.',
      '',
      '- [ ] The last tab is kept per ticket.',
      '',
      'fake: wait 60s',
    ].join('\n'),
    review: { round: 1, state: 'yours', implementer: 'Pip-3', reviewer: '' },
    activity: [
      {
        ago: 40,
        author: 'Agent Pip-3',
        body: 'Done: the last open tab is kept per ticket.\n\n#### How to review\n\n1. [src/last.js:2-4](src/last.js#L2-L4): where it is kept.\n\nReady for review.',
      },
    ],
    commits: [
      {
        message: 'BL-15: Remember the last open tab',
        files: {
          'src/last.js':
            '// The last tab opened per ticket.\nexport function rememberTab(state, id, tab) {\n  return { ...state, tabs: { ...state.tabs, [id]: tab } };\n}\n',
        },
      },
    ],
  },
];

/** Writes files in a repo (or a worktree), then commits exactly those files. */
function commit(root, message, files) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  git(root, 'add', '--', ...Object.keys(files));
  git(root, 'commit', '-q', '-m', message);
}

const branchExists = (dir, branch) => {
  try {
    git(dir, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
};

/**
 * A branch in its own worktree (.worktrees/, as Flotilla lays them out): its commits, then the changes not committed
 * (staged, unstaged, untracked), and published: its upstream on origin. A branch that exists already is left as it is.
 */
function branchWorktree(dir, { branch, commits = [], dirty = {}, published = false }, from) {
  if (branchExists(dir, branch)) return;
  const folder = path.join(dir, '.worktrees', branch.replace(/\//g, '-'));
  git(dir, 'worktree', 'add', '-q', '-b', branch, folder, from);
  for (const c of commits) commit(folder, c.message, c.files);
  for (const [rel, text] of Object.entries(dirty.staged ?? {})) {
    fs.mkdirSync(path.dirname(path.join(folder, rel)), { recursive: true });
    fs.writeFileSync(path.join(folder, rel), text);
    git(folder, 'add', '--', rel);
  }
  for (const [rel, text] of Object.entries(dirty.unstaged ?? {})) fs.writeFileSync(path.join(folder, rel), text);
  for (const [rel, text] of Object.entries(dirty.untracked ?? {})) fs.writeFileSync(path.join(folder, rel), text);
  // As if pushed: a remote-tracking ref of its commit, and its upstream (playground.mjs pushes it to the local origin).
  if (published) {
    git(dir, 'update-ref', `refs/remotes/origin/${branch}`, `refs/heads/${branch}`);
    git(dir, 'config', `branch.${branch}.remote`, 'origin');
    git(dir, 'config', `branch.${branch}.merge`, `refs/heads/${branch}`);
  }
}

/** Keeps the playground's worktrees and its backlog folder out of its own git status (as Flotilla does). */
function exclude(dir, lines) {
  const file = path.resolve(dir, git(dir, 'rev-parse', '--git-path', 'info/exclude'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const missing = lines.filter((l) => !current.split(/\r?\n/).includes(l));
  if (missing.length) fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
}

/**
 * Seeds dir (a git repo, on main, with its first commit) with the backlog and the worktrees, unless it has a backlog
 * already. Returns whether it seeded.
 */
export function seedPlayground(dir, now = new Date()) {
  const backlog = path.join(dir, '.flotilla', 'backlog');
  if (fs.existsSync(path.join(backlog, 'backlog.json'))) return false;
  exclude(dir, ['/.flotilla/', '/.worktrees/']);
  const first = git(dir, 'rev-parse', 'HEAD');
  for (const t of TICKETS.filter((t) => t.from === 'first' && t.branch)) branchWorktree(dir, t, first);
  // main moves on past the first commit, so the branches started from it are behind.
  commit(dir, 'Say what the playground is for', { 'NOTES.md': '# Playground notes\n\nMade by scripts/playground.mjs: a place to try Flotilla.\n' });
  const main = git(dir, 'rev-parse', 'HEAD');
  for (const t of TICKETS.filter((t) => t.branch && t.from !== 'first')) branchWorktree(dir, t, main);
  writeBacklog(backlog, now);
  seedEvents(dir, now);
  return true;
}

/** A small picture of a window: a coloured title bar with a label, and some lines of text. */
function picture(colour, label) {
  const lines = [0, 1, 2, 3].map((i) => `<rect x="24" y="${70 + i * 26}" width="${280 - i * 40}" height="10" rx="5" fill="#8884"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240" viewBox="0 0 480 240"><rect width="480" height="240" rx="8" fill="#1e1e1e"/><rect width="480" height="40" rx="8" fill="${colour}"/><text x="20" y="26" font-family="sans-serif" font-size="16" fill="#fff">${label}</text>${lines}</svg>\n`;
}

/**
 * A small recording: a window whose bar fills up, a frame each half second (`frames` of them), as a demo GIF looks
 * like in a ticket (BL-135).
 */
function recording(colour, frames) {
  const [w, h] = [320, 180];
  const rgb = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16));
  const gif = GIFEncoder();
  for (let f = 0; f < frames; f++) {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const bar = y < 28 || (y > 80 && y < 100 && x > 20 && x < 20 + ((w - 40) * (f + 1)) / frames);
        data.set(bar ? [...rgb, 255] : [30, 30, 30, 255], (y * w + x) * 4);
      }
    const palette = quantize(data, 16);
    gif.writeFrame(applyPalette(data, palette), w, h, { palette, delay: 500 });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

/** backlog.json and the tickets: each ticket's file, its review's handled reports, and its description's fingerprint. */
function writeBacklog(backlog, now) {
  fs.mkdirSync(backlog, { recursive: true });
  const items = TICKETS.map((t) => {
    const activity = t.activity.map((e) => ({ date: entryDate(new Date(now.getTime() - e.ago * 60_000)), author: e.author, body: e.body }));
    const item = { id: t.id, title: t.title, status: t.status, created: new Date(now.getTime() - t.daysAgo * 86_400_000).toISOString() };
    if (t.priority) item.priority = t.priority;
    if (t.proposed) item.proposed = t.proposed;
    if (t.parent) item.parent = t.parent;
    if (t.links) item.links = t.links;
    if (t.branch) item.branches = [t.branch];
    if (t.review) item.review = { ...t.review, handled: activity.filter(actionable).map((e) => entryKey(t.id, e)) };
    item.descriptionHash = descriptionHash(t.description);
    for (const [name, text] of Object.entries(t.files ?? {})) {
      fs.mkdirSync(path.join(backlog, t.id), { recursive: true });
      fs.writeFileSync(path.join(backlog, t.id, name), text);
    }
    fs.writeFileSync(path.join(backlog, `${t.id}.md`), formatTicket({ title: t.title, description: t.description, activity }));
    return item;
  });
  // Last: the backlog's presence says the playground is seeded.
  const data = { version: 1, next: TICKETS.length + 1, counters: { BL: TICKETS.length }, items };
  fs.writeFileSync(path.join(backlog, 'backlog.json'), `${JSON.stringify(data, null, 1)}\n`);
}

// ---- chats (BL-123) ----

/** The seeded chats' session ids: fixed, so seeding again rewrites the same chats. */
const AGENT_CHAT = '7a3e5b21-4c6d-4f80-9b1a-2d3c4e5f6a70';
const PANEL_CHAT = '8b4f6c32-5d7e-4a91-8c2b-3e4d5f6a7b81';
/** An agent's chat whose process ended without its record saying so: it shows as working, for a Check to find (BL-163). */
const STALE_CHAT = '9c5a7d43-6e8f-4ba2-9d3c-4f5e6a7b8c92';
const BL3_WORKTREE = path.join('.worktrees', 'feature-BL-3-keep-chats-when-a-window-reloads');
const MODEL = 'claude-opus-5-5';

/** Vega-2's todo list (TodoWrite), with its first `done` steps done and the next in progress. */
const PLAN = [
  ['Read the ticket and find where chats are saved', 'Reading the ticket'],
  ["Add chatOf, to find a worktree's chat again", 'Adding chatOf'],
  ['Read the store when the window starts', 'Reading the store on start'],
  ['Run the chat tests', 'Running the chat tests'],
  ['Report in the ticket', 'Reporting in the ticket'],
];
const plan = (done) =>
  PLAN.map(([content, activeForm], i) => ({ content, activeForm, status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending' }));

/**
 * The turns of a chat, as Claude Code writes its transcript: `say` is the user's prompt, `reply` Claude's text, `tools`
 * the calls it makes (each with its result; one without runs on, and ends the turn).
 */
const AGENT_TURNS = [
  {
    say: 'You are agent Vega-2, working on backlog item BL-3: "Keep chats when a window reloads". Read its ticket, then go on.',
    tools: [
      {
        name: 'Read',
        input: { file_path: '.flotilla/backlog/BL-3.md' },
        result: "# Keep chats when a window reloads\n\nA window that reloads finds its agents' chats again.",
      },
      {
        name: 'Grep',
        input: { pattern: 'saveChat', description: 'Find where chats are saved' },
        result: 'src/chats.js:1:export function saveChat(store, worktree, id) {',
      },
      { name: 'TodoWrite', input: { todos: plan(1) }, result: 'Todos have been modified successfully.' },
    ],
    reply: "The chat's id is saved with its worktree in `src/chats.js`, but nothing reads it back after a reload.",
  },
];
/** What the agent goes on with: appended one at a time by a demo's `agentTurn` step, so the transcript view follows it. */
const AGENT_NEXT = [
  {
    tools: [{ name: 'Edit', input: { file_path: 'src/chats.js', description: 'Add chatOf' }, result: 'The file src/chats.js has been updated.' }],
    reply: 'Added chatOf, which finds the chat of a worktree again. Next: read the store on start.',
  },
  {
    // Its tests run on: the call has no result yet (BL-175's status shows it running).
    tools: [
      { name: 'TodoWrite', input: { todos: plan(3) }, result: 'Todos have been modified successfully.' },
      { name: 'Bash', input: { command: 'npm test -- chats', description: 'Run the chat tests' } },
    ],
  },
];
const STALE_TURNS = [
  {
    say: 'You are agent Orbit-2, working on backlog item BL-3: "Keep chats when a window reloads". Check the tests of src/chats.js, then report.',
    tools: [{ name: 'Bash', input: { command: 'npm test -- chats', description: 'Run the chat tests' }, result: '2 passed' }],
    reply: 'The chat tests pass. Reporting in the ticket next.',
  },
];
const PANEL_TURNS = [
  {
    say: 'What does chatOf return for a worktree that has no chat yet?',
    tools: [{ name: 'Read', input: { file_path: 'src/chats.js' }, result: 'export function chatOf(store, worktree) {\n  return store[worktree];\n}' }],
    reply: "`undefined`: `chatOf` reads the store's key for the worktree, and there's none until `saveChat` writes it.",
  },
];

/** A turn's transcript lines, from `at` on, a second apart. */
function turnLines(turn, { sessionId, cwd, entrypoint, n }, at) {
  let t = at.getTime();
  const base = () => ({ sessionId, cwd, entrypoint, version: '2.1.0', isSidechain: false, timestamp: new Date((t += 1000)).toISOString() });
  const id = (kind, i = 0) => `${sessionId.slice(0, 8)}-${n}-${kind}-${i}`;
  const lines = [];
  if (turn.say) lines.push({ type: 'user', ...base(), uuid: id('u'), message: { role: 'user', content: turn.say } });
  const usage = { input_tokens: 4, cache_read_input_tokens: 18000 + n * 900, cache_creation_input_tokens: 600, output_tokens: 180 };
  for (const [i, tool] of (turn.tools ?? []).entries()) {
    const call = { type: 'tool_use', id: `toolu_${id('t', i).replace(/-/g, '')}`, name: tool.name, input: tool.input };
    lines.push({ type: 'assistant', ...base(), uuid: id('a', i), message: { id: id('m', i), role: 'assistant', model: MODEL, content: [call], usage } });
    // A call without a result still runs.
    if (tool.result === undefined) break;
    lines.push({
      type: 'user',
      ...base(),
      uuid: id('r', i),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: tool.result }] },
    });
  }
  if (turn.reply)
    lines.push({
      type: 'assistant',
      ...base(),
      uuid: id('a', 'end'),
      message: { id: id('m', 'end'), role: 'assistant', model: MODEL, content: [{ type: 'text', text: turn.reply }], usage },
    });
  return lines.map((l) => `${JSON.stringify(l)}\n`).join('');
}

/** Where Claude Code keeps a chat's transcript: <home>/projects/<cwd, every non-alphanumeric character a '-'>/<id>.jsonl. */
const transcriptFile = (home, cwd, sessionId) => path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);

/**
 * Seeds the playground's chats: an agent's (claude -p, so it opens read-only, BL-121) in BL-3's worktree, working,
 * a panel chat there, done, and an agent's that shows as working though nothing runs it (for a Check, BL-163). Their records go to the worktree's git folder (as Flotilla's hook writes them), their
 * transcripts to `claudeHome`'s projects (the demo window's own home: never the user's). Written again on every call,
 * so the agent's chat is fresh and open whenever a demo starts. Returns the transcripts' paths.
 */
export function seedChats(dir, claudeHome, now = new Date()) {
  const cwd = path.join(dir, BL3_WORKTREE);
  if (!fs.existsSync(cwd)) return [];
  const records = path.resolve(cwd, git(cwd, 'rev-parse', '--git-dir'), 'flotilla', 'chats');
  fs.mkdirSync(records, { recursive: true });
  const chats = [
    { sessionId: AGENT_CHAT, entrypoint: 'sdk-cli', turns: AGENT_TURNS, title: 'Vega-2 · BL-3', state: 'working', agent: 'Vega-2', ago: 6 },
    { sessionId: PANEL_CHAT, entrypoint: 'claude-vscode', turns: PANEL_TURNS, title: 'What chatOf returns without a chat', state: 'done', ago: 50 },
    // Last written 7 minutes ago, and nothing runs it: it shows as working until a Check cleans it up.
    { sessionId: STALE_CHAT, entrypoint: 'sdk-cli', turns: STALE_TURNS, title: 'Orbit-2 · BL-3', state: 'working', agent: 'Orbit-2', ago: 8, quietFor: 7 },
  ];
  return chats.map((c) => {
    const startedAt = new Date(now.getTime() - c.ago * 60_000);
    const lines = c.turns.map((turn, n) => turnLines(turn, { ...c, cwd, n }, new Date(startedAt.getTime() + n * 60_000))).join('');
    const file = transcriptFile(claudeHome, cwd, c.sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines}${JSON.stringify({ type: 'custom-title', sessionId: c.sessionId, customTitle: c.title })}\n`);
    const updatedAt = c.quietFor ? new Date(now.getTime() - c.quietFor * 60_000) : now;
    if (c.quietFor) fs.utimesSync(file, updatedAt, updatedAt);
    const record = {
      sessionId: c.sessionId,
      state: c.state,
      cwd,
      linkedBy: 'cwd',
      firstPrompt: c.turns[0].say.slice(0, 200),
      startedAt: startedAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    };
    if (c.agent) record.agent = c.agent;
    fs.writeFileSync(path.join(records, `${c.sessionId}.json`), `${JSON.stringify(record, null, 1)}\n`);
    return file;
  });
}

/** Above any process id (Linux's pid_max is at most 2^22): a window that's gone. */
const GONE_PID = 4_194_305;

/**
 * Seeds a "Creating its worktree…" record for BL-5 left by a window that closed mid-creation (BL-167): it blocks
 * nothing (its process is gone), and a Check finds it and clears it. Written again on every call; returns its path.
 */
export function seedCreating(dir, now = new Date()) {
  const records = path.join(path.resolve(dir, git(dir, 'rev-parse', '--git-common-dir')), 'flotilla', 'creating');
  fs.mkdirSync(records, { recursive: true });
  const file = path.join(records, 'BL-5.json');
  fs.writeFileSync(file, JSON.stringify({ id: 'BL-5', pid: GONE_PID, host: os.hostname(), at: now.getTime() - 3 * 60_000 }));
  return file;
}

/**
 * The agent's chat goes on: its next turn (of AGENT_NEXT) is appended to its transcript, and its record says it's
 * still working. Returns false when it has no turn left (or wasn't seeded).
 */
export function appendAgentTurn(dir, claudeHome, now = new Date()) {
  const cwd = path.join(dir, BL3_WORKTREE);
  const file = transcriptFile(claudeHome, cwd, AGENT_CHAT);
  if (!fs.existsSync(file)) return false;
  // The turns written so far, by the turn number in their lines' uuids (a turn may end without a reply).
  const done = new Set([...fs.readFileSync(file, 'utf8').matchAll(/"uuid":"[0-9a-f]{8}-(\d+)-/g)].map((m) => m[1])).size;
  const next = AGENT_NEXT[done - AGENT_TURNS.length];
  if (!next) return false;
  fs.appendFileSync(file, turnLines(next, { sessionId: AGENT_CHAT, cwd, entrypoint: 'sdk-cli', n: done }, now));
  const recordFile = path.resolve(cwd, git(cwd, 'rev-parse', '--git-dir'), 'flotilla', 'chats', `${AGENT_CHAT}.json`);
  if (fs.existsSync(recordFile)) {
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    fs.writeFileSync(recordFile, `${JSON.stringify({ ...record, state: 'working', updatedAt: now.toISOString() }, null, 1)}\n`);
  }
  return true;
}

/** Marks the events seedEvents writes, so the next seeding replaces them and leaves the playground's own. */
const SEEDED = '"seeded":true';

/**
 * Seeds a month of events (BL-158's Metrics view), up to now: tickets going from To Do to merged through work, review,
 * waits for you and merges (some conflicted, some checks failing), agents' costs, idle spells, a usage limit and slow
 * clicks. The same every time for the same now (a fixed random seed); written again on every call, in place of the
 * last seeding's. Returns how many it wrote.
 */
export function seedEvents(dir, now = new Date()) {
  const metrics = path.join(path.resolve(dir, git(dir, 'rev-parse', '--git-common-dir')), 'flotilla', 'metrics');
  fs.mkdirSync(metrics, { recursive: true });
  let state = 158;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const between = (a, b) => a + random() * (b - a);
  const M = 60_000;
  const end = now.getTime();
  const events = [];
  const add = (t, kind, data, ticket, agent) => {
    if (t <= end)
      events.push({ at: new Date(t).toISOString(), kind, ...(ticket ? { ticket } : {}), ...(agent ? { agent } : {}), data, imported: true, seeded: true });
  };
  const agents = ['Vega-2', 'Nova-7', 'Orbit-2', 'Atlas-8', 'Onyx-4'];
  const files = ['src/greet.js', 'src/server.js', 'README.md', 'src/last.js', 'package.json', 'test/greet.test.js'];
  const tokens = (k) => ({ input: Math.round(k * 300), output: Math.round(k * 120), cacheRead: Math.round(k * 2400), cacheCreation: Math.round(k * 200) });
  // A run's spend, split by purpose as the transcripts are (BL-189): its turns' context and its tools' output.
  const spend = (t, minutes, purpose, usd, s, id, agent) => {
    const turns = Math.max(1, Math.round(minutes / 5));
    const contextK = Array.from({ length: turns }, (_, i) => Math.round(30 + (i / turns) * between(60, 200)));
    const tools = {
      code: Math.round(minutes * between(2000, 5000)),
      git: Math.round(minutes * between(300, 1500)),
      tests: Math.round(minutes * between(100, 800)),
      other: Math.round(minutes * 200),
    };
    add(
      t,
      'agent-spend',
      { session: s, purpose, to: new Date(t + minutes * M).toISOString(), tokens: tokens(minutes), costUsd: Math.round(usd * 100) / 100, contextK, tools },
      id,
      agent,
    );
  };
  let n = 0;
  let session = 0;
  // A ticket's way, from its start at t: work, review (sent back now and then), your approval, its merge.
  const ticket = (t) => {
    const id = `BL-${(n++ % 15) + 1}`;
    const worker = agents[n % agents.length];
    const reviewer = agents[(n + 2) % agents.length];
    add(t, 'ticket-moved', { from: 'todo', to: 'doing', by: 'Autopilot' }, id);
    for (let round = 1; ; round++) {
      const s = `seed-${session++}`;
      const work = between(30, 140) * M;
      add(t, round === 1 ? 'agent-started' : 'agent-resumed', { role: 'work', session: s, model: 'opus' }, id, worker);
      spend(t, work / M, round === 1 ? 'first' : 'rework', (work / M) * 0.06, s, id, worker);
      if (random() < 0.15) spend(t + work / 2, between(3, 15), 'resume', between(0.2, 0.9), s, id, worker);
      t += work;
      add(
        t,
        'agent-ended',
        { role: 'work', session: s, code: 0, ok: true, minutes: Math.round(work / M), tokens: tokens(work / M), costUsd: Math.round(work / M) * 0.06 },
        id,
        worker,
      );
      add(t, 'ticket-moved', { from: 'doing', to: 'review', by: 'Flotilla' }, id);
      t += between(5, 60) * M;
      const r = `seed-${session++}`;
      const review = between(10, 35) * M;
      add(t, 'agent-started', { role: 'review', session: r, model: 'opus' }, id, reviewer);
      spend(t, review / M, 'review', (review / M) * 0.05, r, id, reviewer);
      t += review;
      add(
        t,
        'agent-ended',
        { role: 'review', session: r, code: 0, ok: true, minutes: Math.round(review / M), tokens: tokens(review / M), costUsd: Math.round(review / M) * 0.05 },
        id,
        reviewer,
      );
      const back = round < 3 && random() < 0.25;
      add(t, 'review-verdict', { verdict: back ? 'changes' : 'approved', round, by: `Agent ${reviewer}` }, id, reviewer);
      if (!back) break;
      add(t, 'ticket-moved', { from: 'review', to: 'doing', by: 'Flotilla' }, id);
    }
    add(t, 'review-state', { from: 'reviewing', to: 'yours' }, id);
    // Overnight, a ticket waits for you longer.
    t += between(10, new Date(t).getHours() >= 20 ? 600 : 150) * M;
    add(t, 'review-verdict', { verdict: 'approved', round: 1, by: 'You' }, id);
    add(t, 'review-state', { from: 'yours', to: 'approved' }, id);
    t += between(1, 20) * M;
    add(t, 'merge-started', { into: 'main', branch: `feature/${id}` }, id);
    if (random() < 0.3) {
      const pure = random() < 0.5;
      const conflicted = files.filter(() => random() < 0.35).slice(0, 3);
      if (!conflicted.length) conflicted.push(files[Math.floor(random() * files.length)]);
      add(t + M, 'merge-conflicted', { files: conflicted.map((file) => ({ file, regions: [{ lines: Math.ceil(between(1, 12)), additions: pure }] })) }, id);
      const m = `seed-${session++}`;
      const resolve = between(4, 20) * M;
      add(t + M, 'agent-started', { role: 'merge', session: m }, id, worker);
      spend(t + M, resolve / M, 'main', (resolve / M) * 0.04, m, id, worker);
      add(
        t + M + resolve,
        'agent-ended',
        {
          role: 'merge',
          session: m,
          code: 0,
          ok: true,
          minutes: Math.round(resolve / M),
          tokens: tokens(resolve / M),
          costUsd: Math.round(resolve / M) * 0.04,
        },
        id,
        worker,
      );
      add(t + M + resolve, 'merge-resolved', { minutes: Math.round(resolve / M), by: `Agent ${worker}` }, id, worker);
      t += M + resolve + between(2, 40) * M;
      add(t, 'merge-approved', { by: 'You' }, id);
    }
    if (random() < 0.12) {
      const timeout = random() < 0.5;
      t += between(4, 9) * M;
      add(t, 'merge-checks-failed', { failure: timeout ? 'timeout' : 'assertion', tests: timeout ? [] : ['test/greet.test.js > greets without a comma'] }, id);
      add(t + 2 * M, 'merge-started', { into: 'main', branch: `feature/${id}` }, id);
    }
    t += between(3, 9) * M;
    add(
      t,
      'merge-landed',
      {
        into: 'main',
        commit: Math.floor(random() * 0xffffff)
          .toString(16)
          .padStart(7, '0'),
      },
      id,
    );
    add(t, 'ticket-moved', { from: 'review', to: 'done', by: 'Flotilla', criteria: Math.ceil(between(2, 8)) }, id);
  };
  // Two to four tickets start a day, the last ones still under way now.
  for (let day = 30; day >= 0; day--) {
    const midnight = new Date(end - day * 86_400_000);
    midnight.setHours(0, 0, 0, 0);
    const starts = Math.floor(between(2, 5));
    // Your own chats with Claude: orchestration, not a ticket's.
    const chat = between(10, 60);
    spend(midnight.getTime() + between(8, 11) * 60 * M, chat, 'orchestration', chat * 0.07, `seed-own-${day}`);
    for (let i = 0; i < starts; i++) ticket(midnight.getTime() + between(8, 18) * 60 * M);
    // An idle evening: what waits is held back by what isn't merged yet.
    add(midnight.getTime() + 21 * 60 * M, 'autopilot-idle', { reason: random() < 0.6 ? 'BL-5 waits for BL-2 (In Progress)' : 'nothing left in To Do' });
    if (random() < 0.2) add(midnight.getTime() + 22 * 60 * M, 'autopilot-idle', { reason: '1 merge failed (BL-13): it needs you' });
    if (random() < 0.5)
      add(
        midnight.getTime() + between(9, 19) * 60 * M,
        'click-waited',
        { button: random() < 0.5 ? 'backlog:approve' : 'backlog:start', ms: Math.round(between(1000, 6000)) },
        `BL-${Math.ceil(between(1, 15))}`,
      );
    if (day % 9 === 4) {
      const hit = midnight.getTime() + 16 * 60 * M;
      add(hit, 'limit-hit', { limit: 'five-hour', until: new Date(hit + 90 * M).toISOString(), known: true });
      add(hit + 90 * M, 'limit-lifted', { minutes: 90 });
    }
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  // Each month's file: the playground's own events kept, the last seeding's replaced.
  const byMonth = new Map();
  for (const e of events) {
    const month = e.at.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? '') + `${JSON.stringify(e)}\n`);
  }
  for (const name of fs.readdirSync(metrics).filter((f) => /^events-\d{4}-\d{2}\.jsonl$/.test(f))) {
    const file = path.join(metrics, name);
    const kept = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.includes(SEEDED));
    fs.writeFileSync(file, kept.length ? `${kept.join('\n')}\n` : '');
  }
  for (const [month, text] of byMonth) fs.appendFileSync(path.join(metrics, `events-${month}.jsonl`), text);
  return events.length;
}
