import * as vscode from 'vscode';
import { openChangesEditor } from '../../core/diff/openDiff';
import { runGit } from '../../core/git/gitCli';
import { parseNameStatus } from '../../core/git/porcelain';
import { samePath } from '../../core/paths';
import type { CreateRequest } from '../../features/worktrees/worktreeService';
import {
  agentChatItem,
  agentLead,
  agentName,
  type BacklogItem,
  branchMatches,
} from '../../features/backlog/backlog';
import {
  branchStart,
  cleanBranchName,
  cleanUpPrompt,
  compareRewrite,
  countCommits,
  finishRewrite,
  historyRef,
  type HistoryRewrite,
} from '../../features/backlog/history';
import { resolveBase } from '../../features/workstreams/progress';
import type { Workstream } from '../../features/workstreams/workstream';
import * as chatUi from '../chatCommands';
import type { CommandContext } from '../commands';
import { workstreamLabel } from '../format';
import { trackProgress } from '../progress';
import {
  agentChoice,
  describeChoice,
} from './agentRunner';
import { readSettings } from '../settings';

/** What the clean-ups need from the commands (worktrees are created and set up there). */
export interface CleanUpDeps {
  ctx: CommandContext;
  chats: chatUi.ChatContext;
  createWorkstream(request: CreateRequest): Promise<string>;
  enforceCommitPrefix(ws: Workstream, id: string): Promise<void>;
}

const mainRoot = (d: CleanUpDeps) => d.ctx.service.roots.mainRoot;

async function localItem(d: CleanUpDeps, id: unknown): Promise<BacklogItem | undefined> {
  if (typeof id !== 'string') return undefined;
  return (await d.ctx.backlog.read()).items.find((i) => i.id === id);
}

async function setRewrite(d: CleanUpDeps, id: string, change: (item: BacklogItem) => Partial<BacklogItem>): Promise<void> {
  await d.ctx.backlog.change((data) => ({ ...data, items: data.items.map((i) => (i.id === id ? { ...i, ...change(i) } : i)) }));
}

function worktreeOn(d: CleanUpDeps, branch: string): Workstream | undefined {
  return d.ctx.repository.current.find((w) => w.worktree.branch === branch && w.worktree.path);
}

/**
 * Starts cleaning up the history of one of an item's branches: a worktree on a new branch from where it started, where
 * an agent (in a chat, with the user) or the user writes the clean commits. It's finished (or cancelled) from the
 * ticket.
 */
export async function startCleanUp(d: CleanUpDeps, id: unknown, opts?: unknown): Promise<void> {
  // Given (by a caller that asked already): who writes it, and which branch.
  const given = typeof opts === 'object' && opts !== null ? (opts as { by?: unknown; branch?: unknown }) : {};
  const item = await localItem(d, id);
  if (!item) return;
  if (item.rewrite) {
    void vscode.window.showInformationMessage(`${item.id}'s history is already being cleaned up, in ${item.rewrite.clean}. Finish or cancel that first.`);
    return;
  }
  const root = mainRoot(d);
  const base = await resolveBase(root, readSettings().defaultBase);
  if (!base) {
    void vscode.window.showWarningMessage("Can't tell which branch the work is based on: set flotilla.defaultBase.");
    return;
  }
  const local = (await runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: root })).split('\n').filter(Boolean);
  // The item's branches with work on them (not clean-ups of them).
  const candidates: Array<{ branch: string; start: string; commits: number }> = [];
  for (const branch of local.filter((b) => b !== base && branchMatches(item, b) && !/-clean(-\d+)?$/.test(b))) {
    const start = await branchStart(root, branch, base).catch(() => '');
    const commits = start ? await countCommits(root, start, `refs/heads/${branch}`) : 0;
    if (commits > 0) candidates.push({ branch, start, commits });
  }
  if (!candidates.length) {
    void vscode.window.showInformationMessage(`${item.id} has no commits to clean up: none of its branches has commits that ${base} doesn't.`);
    return;
  }
  const target =
    candidates.find((c) => c.branch === given.branch) ??
    (candidates.length === 1
      ? candidates[0]
      : (
          await vscode.window.showQuickPick(
            candidates.map((c) => ({ label: c.branch, description: `${c.commits} commits`, c })),
            { title: `Clean up the history of ${item.id}`, placeHolder: 'Which branch?' },
          )
        )?.c);
  if (!target) return;
  const by = given.by === 'agent' || given.by === 'you' ? { by: given.by as HistoryRewrite['by'] } : undefined;
  const who =
    by ??
    (await vscode.window.showQuickPick(
      [
        {
          label: '$(hubot) With an Agent',
          detail: 'In a Claude Code chat: it proposes the clean commits, and writes them once you agree',
          by: 'agent' as const,
        },
        { label: '$(account) Myself', detail: `In a new worktree from where ${target.branch} started; finish it from the ticket`, by: 'you' as const },
      ],
      { title: `Clean up the history of ${target.branch} (${target.commits} commits)`, placeHolder: 'Who writes the clean history?' },
    ));
  if (!who) return;
  const clean = cleanBranchName(target.branch, local);
  const key = await d.createWorkstream({ kind: 'new', branch: clean, startPoint: target.start });
  const ws = d.ctx.repository.current.find((w) => w.key === key);
  if (!ws?.worktree.path) return;
  await d.enforceCommitPrefix(ws, item.id);
  const taken = d.ctx.repository.current.flatMap((w) => w.chats.map((c) => agentChatItem(c.firstPrompt)?.agent ?? '')).filter(Boolean);
  const agent = who.by === 'agent' ? agentName(taken) : undefined;
  const rewrite: HistoryRewrite = {
    branch: target.branch,
    clean,
    base: target.start,
    by: who.by,
    ...(agent ? { agent } : {}),
    started: new Date().toISOString(),
  };
  await setRewrite(d, item.id, () => ({ rewrite }));
  const where = `worktree \`${workstreamLabel(ws)}\``;
  if (agent) {
    const ticket = await d.ctx.backlog.ensureDocument(item);
    const choice = agentChoice(item);
    const shown = await chatUi.startAgent(
      d.chats,
      ws,
      cleanUpPrompt({ id: item.id, ticket, branch: target.branch, clean, base: target.start, commits: target.commits, agent }),
      agentLead(item, agent),
      { choice, name: `${agent} · ${item.id} history`, track: { ticket: item.id, agent, role: 'work' } },
    );
    // "chat for agent <name>": the ticket links the note to the chat by it.
    await d.ctx.tickets.addActivity(
      item.id,
      'Flotilla',
      `Started cleaning up the history of \`${target.branch}\` (${target.commits} commits): opened a chat for agent ${agent}${describeChoice(choice)} in ${where}${shown === 'terminal' ? ', in a terminal' : ''}. It proposes the clean commits to you there.`,
    );
  } else {
    await d.ctx.tickets.addActivity(
      item.id,
      'Flotilla',
      `Started cleaning up the history of \`${target.branch}\` (${target.commits} commits), by you, in ${where}.`,
    );
    void vscode.window.showInformationMessage(
      `Write the clean history of ${target.branch} in ${clean}: it starts where ${target.branch} started. When it ends at the same files, finish it from ${item.id}'s ticket.`,
    );
  }
  d.ctx.sidebar.reveal(ws.key);
}

/** Opens what still differs between the clean history's end and the branch's. */
export async function compareCleanUp(d: CleanUpDeps, id: unknown): Promise<void> {
  const item = await localItem(d, id);
  const r = item?.rewrite;
  if (!r) return;
  const { differs } = await compareRewrite(mainRoot(d), r);
  if (!differs.length) {
    void vscode.window.showInformationMessage(`${r.clean} ends at the same files as ${r.branch}.`);
    return;
  }
  const changes = parseNameStatus(
    await runGit(['diff', '--name-status', '-z', '--no-renames', `refs/heads/${r.clean}`, `refs/heads/${r.branch}`, '--'], { cwd: mainRoot(d) }),
  );
  await openChangesEditor(d.ctx.reference, mainRoot(d), changes, `refs/heads/${r.clean}`, `refs/heads/${r.branch}`, `${r.clean} ↔ ${r.branch}`);
}

/**
 * Finishes a clean-up: the branch's old history is kept (a hidden ref), the branch moves to the clean commits (in its
 * worktree: no files change there), and the clean worktree and branch are removed. Asks first.
 */
export async function finishCleanUp(d: CleanUpDeps, id: unknown, opts?: unknown): Promise<void> {
  // A caller that asked the user already.
  const confirmed = typeof opts === 'object' && opts !== null && (opts as { confirmed?: unknown }).confirmed === true;
  const item = await localItem(d, id);
  const r = item?.rewrite;
  if (!item || !r) return;
  const root = mainRoot(d);
  const compared = await compareRewrite(root, r);
  if (compared.differs.length) {
    const choice = await vscode.window.showWarningMessage(
      `${r.clean} doesn't end at the same files as ${r.branch} yet: ${compared.differs.length} differ.`,
      { detail: compared.differs.slice(0, 10).join('\n') },
      'Compare',
    );
    if (choice) await compareCleanUp(d, id);
    return;
  }
  const cleanWs = worktreeOn(d, r.clean);
  if (cleanWs?.changes.length) {
    void vscode.window.showWarningMessage(`${r.clean} has ${cleanWs.changes.length} uncommitted change(s): commit or discard them first.`);
    return;
  }
  if (cleanWs?.isCurrent) {
    void vscode.window.showWarningMessage(`This window is open on ${r.clean}, which finishing removes: finish it from another window.`);
    return;
  }
  const work = worktreeOn(d, r.branch);
  const upstream = await runGit(['rev-parse', '--abbrev-ref', `${r.branch}@{upstream}`], { cwd: root }).then(
    (o) => o.trim(),
    () => '',
  );
  const busy = cleanWs?.chats.some((c) => c.state === 'working');
  const choice = confirmed
    ? 'Finish'
    : await vscode.window.showWarningMessage(
        `Finish cleaning up the history of ${r.branch}?`,
        {
          modal: true,
          detail: [
            `${r.branch} moves to the ${compared.cleanCommits} clean commit(s) (it has ${compared.commits} now); its files don't change.`,
            `Its old history is kept as ${historyRef(item.id, (item.history?.length ?? 0) + 1).replace(/v\d+$/, 'v…')}, shown on the ticket.`,
            `The worktree ${r.clean} and its branch are removed.`,
            ...(busy ? ['An agent is still working in it.'] : []),
            ...(upstream ? [`It's pushed (${upstream}): publishing it again takes a force push. Flotilla offers one after this.`] : []),
          ].join('\n'),
        },
        'Finish',
      );
  if (choice !== 'Finish') return;
  // The next version not kept yet.
  const kept = (await runGit(['for-each-ref', '--format=%(refname)', `refs/flotilla/history/${item.id}/`], { cwd: root })).split('\n').filter(Boolean);
  let version = (item.history?.length ?? 0) + 1;
  while (kept.includes(historyRef(item.id, version))) version++;
  const done = await finishRewrite(root, { id: item.id, version, rewrite: r, worktree: work?.worktree.path, now: new Date() });
  await setRewrite(d, item.id, (i) => ({ rewrite: undefined, history: [...(i.history ?? []), done] }));
  if (cleanWs) {
    const wt = (await d.ctx.service.list()).find((w) => samePath(w.adminDir, cleanWs.worktree.adminDir));
    if (wt)
      await d.ctx.service.remove(wt, { force: false }).catch((e: unknown) => d.ctx.output.appendLine(`Couldn't remove ${r.clean}'s worktree: ${String(e)}`));
  }
  await d.ctx.service.deleteBranch(r.clean, true).catch((e: unknown) => d.ctx.output.appendLine(`Couldn't delete ${r.clean}: ${String(e)}`));
  await d.ctx.tickets.addActivity(
    item.id,
    'Flotilla',
    `Cleaned up the history of \`${r.branch}\`: ${done.commits} commits became ${done.cleanCommits}, with the same files. The old history is kept as version ${done.version} (\`${done.ref}\`).`,
  );
  await d.ctx.repository.refresh();
  if (upstream) await offerForcePush(d, r.branch, work?.worktree.path ?? root);
}

/** Publishes a cleaned-up branch that was pushed before: a force push (with lease), after asking. */
async function offerForcePush(d: CleanUpDeps, branch: string, cwd: string): Promise<void> {
  const remote = (await runGit(['config', `branch.${branch}.remote`], { cwd }).catch(() => '')).trim();
  const merge = (await runGit(['config', `branch.${branch}.merge`], { cwd }).catch(() => '')).trim();
  if (!remote || !merge) return;
  const choice = await vscode.window.showInformationMessage(
    `${branch} has a clean history now, but ${remote} has the old one. Force push it?`,
    {
      modal: true,
      detail: `git push --force-with-lease ${remote} ${branch}:${merge.replace(/^refs\/heads\//, '')}\nIt replaces the branch's history on ${remote} (only if no one pushed to it since you last fetched).`,
    },
    'Force Push',
  );
  if (choice !== 'Force Push') return;
  await trackProgress('vc', `Force pushing ${branch} to ${remote}…`, () =>
    runGit(['push', '--force-with-lease', remote, `refs/heads/${branch}:${merge}`], { cwd, timeoutMs: 120_000 }),
  );
  await d.ctx.repository.refresh();
}

/** Cancels a clean-up: its worktree and branch are removed (after asking); the work's branch stays as it is. */
export async function cancelCleanUp(d: CleanUpDeps, id: unknown): Promise<void> {
  const item = await localItem(d, id);
  const r = item?.rewrite;
  if (!item || !r) return;
  const cleanWs = worktreeOn(d, r.clean);
  if (cleanWs?.isCurrent) {
    void vscode.window.showWarningMessage(`This window is open on ${r.clean}, which cancelling removes: cancel it from another window.`);
    return;
  }
  const commits = await countCommits(mainRoot(d), r.base, `refs/heads/${r.clean}`).catch(() => 0);
  const choice = await vscode.window.showWarningMessage(
    `Cancel cleaning up the history of ${r.branch}?`,
    {
      modal: true,
      detail: [
        `The worktree ${r.clean} and its branch are removed${commits ? `, with its ${commits} clean commit(s)` : ''}${cleanWs?.changes.length ? ` and ${cleanWs.changes.length} uncommitted change(s)` : ''}.`,
        `${r.branch} stays as it is.`,
      ].join('\n'),
    },
    'Cancel Clean-Up',
  );
  if (choice !== 'Cancel Clean-Up') return;
  if (cleanWs) {
    const wt = (await d.ctx.service.list()).find((w) => samePath(w.adminDir, cleanWs.worktree.adminDir));
    if (wt) await d.ctx.service.remove(wt, { force: cleanWs.changes.length > 0 });
  }
  await d.ctx.service.deleteBranch(r.clean, true).catch(() => undefined);
  await setRewrite(d, item.id, () => ({ rewrite: undefined }));
  await d.ctx.tickets.addActivity(item.id, 'Flotilla', `Cancelled the clean-up of \`${r.branch}\`'s history; it stays as it was.`);
  await d.ctx.repository.refresh();
}
