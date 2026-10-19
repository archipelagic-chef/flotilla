// Seeds the playground (.playground, made by playground.mjs) with a backlog and worktrees in every state Flotilla
// handles, so they can be seen without waiting for agents to get there: To Do (proposed, accepted), an epic with parts,
// In Progress with a question, In Review (run blocks of each kind; none; approved; stopped; paused on a usage limit) and
// Done. The unit test (tests/unit/features/playgroundSeed.test.ts) seeds a temporary repo with this and checks what it
// reads as, so change the two together.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
// The app's own code (src/features/backlog/seedKit.ts, built by npm run build), so the seed writes what the app reads.
import { actionable, descriptionHash, entryDate, entryKey, formatTicket } from '../dist/playground-seed-kit.mjs';

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
      'A review card shows a Run button when its ticket has a run block, so the board can try the work.',
      '',
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
    description: ['Tickets take files of any kind, not only images, in parts.', '', '- [ ] Every part below is done.', '- [ ] A file that is too big says so.'].join('\n'),
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
    description: "The status bar shows Claude's usage limit, and when it resets.\n\n- [ ] Shown while the limit is reached.\n- [ ] Hidden when there is no limit.",
    activity: [{ ago: 1440, author: 'Flotilla', body: 'You moved it from **In Review** to **Done**.' }],
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
        ago: 90,
        author: 'Agent Pip-3',
        body: [
          'Done: the last ticket opened in a window is remembered, and opens again on start.',
          '',
          '#### How to review',
          '',
          '1. [src/last.js:2-4](src/last.js#L2-L4): where the id is remembered.',
          '',
          'Try it:',
          '',
          '```run Check the file',
          'node --check src/last.js',
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
        files: { 'src/last.js': '// The last ticket opened in this window.\nexport function rememberTicket(state, id) {\n  return { ...state, lastTicket: id };\n}\n' },
      },
    ],
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
        task: { prompt: 'Add the test for removing a worktree, as the reviewer asked, then report.', why: 'the reviewer asked for a test, and gave no verdict' },
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
        files: { 'src/diff-size.js': '// How many lines a review may look at before it warns.\nexport function warnsAbout(lines, limit = 800) {\n  return lines > limit;\n}\n' },
      },
    ],
  },
  {
    id: 'BL-13',
    title: 'Say hi in the greeting',
    status: 'review',
    daysAgo: 3,
    branch: 'feature/BL-13-say-hi-in-the-greeting',
    description: 'The greeting says hi: "Hi Ada!" instead of "Hello, Ada!".\n\n- [ ] The CLI and the server say hi.',
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
 * (staged, unstaged, untracked). A branch that exists already is left as it is.
 */
function branchWorktree(dir, { branch, commits = [], dirty = {} }, from) {
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
  return true;
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
    if (t.branch) item.branches = [t.branch];
    if (t.review) item.review = { ...t.review, handled: activity.filter(actionable).map((e) => entryKey(t.id, e)) };
    item.descriptionHash = descriptionHash(t.description);
    fs.writeFileSync(path.join(backlog, `${t.id}.md`), formatTicket({ title: t.title, description: t.description, activity }));
    return item;
  });
  // Last: the backlog's presence says the playground is seeded.
  const data = { version: 1, next: TICKETS.length + 1, counters: { BL: TICKETS.length }, items };
  fs.writeFileSync(path.join(backlog, 'backlog.json'), `${JSON.stringify(data, null, 1)}\n`);
}
