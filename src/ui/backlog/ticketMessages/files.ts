import * as vscode from 'vscode';
import { runGit } from '../../../core/git/gitCli';
import { openCommit } from '../../openCommit';
import { openChangeDiff, openChangeEntries } from '../../../core/diff/openDiff';
import type { Handlers } from './context';

/** Opening what the ticket links to: its file, links in it, commits, worktrees, and running its run blocks. */
export const filesHandlers: Handlers = {
  openFile: async ({ item, backlog }) => {
    await vscode.window.showTextDocument(vscode.Uri.file(await backlog.ensureDocument(item)), { preview: false });
  },
  openWorktree: async ({ item, panels }, m) => {
    if (panels.worktreesOf(item).some((w) => w.key === m.key)) panels.deps.revealWorktree(m.key);
  },
  openCommit: async ({ id, item, panels }, m) => {
    // In the history of a worktree that has it (one of the ticket's first, else the main one); its diff otherwise.
    const work = await panels.work(item);
    const { commits } = work;
    const commit = commits.find((c) => c.hash === m.hash);
    // A commit of a kept history is on no branch: its diff.
    if (!commit) {
      if (work.history.some((v) => v.log.some((c) => c.hash === m.hash))) await openCommit(panels.deps.reference, panels.deps.mainRoot, m.hash);
      return;
    }
    const candidates = [
      ...panels.worktreesOf(item).filter((w) => w.worktree.branch && commit.branches.includes(w.worktree.branch)),
      ...panels.worktreesOf(item),
      ...panels.deps.repository.current.filter((w) => w.worktree.isMain),
    ];
    for (const ws of candidates) {
      if (!ws.worktree.path) continue;
      const has = await runGit(['merge-base', '--is-ancestor', m.hash, 'HEAD'], { cwd: ws.worktree.path }).then(
        () => true,
        () => false,
      );
      if (has) {
        await panels.deps.showCommits(
          ws.key,
          id,
          commits.map((c) => c.hash),
          m.hash,
        );
        return;
      }
    }
    await openCommit(panels.deps.reference, panels.deps.mainRoot, m.hash);
  },
  openChange: async ({ item, panels }, m) => {
    // The change as the ticket shows it: what it lists is what opens.
    const g = (await panels.changesShown(item)).groups[m.group];
    const f = g?.files.find((x) => x.path === m.path);
    if (g && f) await openChangeDiff(panels.deps.reference, g.dir, f, f.left ?? g.left, f.right ?? g.right, `${item.id}: ${g.label}`);
  },
  openAllChanges: async ({ item, panels }) => {
    const { groups } = await panels.changesShown(item);
    const entries = groups.flatMap((g) => g.files.map((f) => ({ worktreeDir: g.dir, change: f, leftRef: f.left ?? g.left, rightRef: f.right ?? g.right })));
    if (!entries.length) {
      void vscode.window.showInformationMessage(`${item.id} changes no files yet.`);
      return;
    }
    await openChangeEntries(panels.deps.reference, entries, `${item.id}: Changes`);
  },
  openHref: async ({ item, panels }, m) => {
    await panels.openHref(item, m.href);
  },
  run: async ({ id }, m) => {
    await vscode.commands.executeCommand('flotilla.runBacklogItem', id, { key: m.key, index: m.index, ...(m.try ? { try: true } : {}) });
  },
  checkout: async ({ id, item, panels }, m) => {
    if ((await panels.work(item)).branches.includes(m.branch))
      await vscode.commands.executeCommand('flotilla.startBacklogItem', id, { agent: false, branch: m.branch });
  },
};
