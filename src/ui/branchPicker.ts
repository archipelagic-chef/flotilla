import { branchNameProblem } from '../features/worktrees/layout';
import type { BranchList } from '../features/worktrees/worktreeService';

export type BranchPickAction =
  | { kind: 'createNamed'; branch: string }
  | { kind: 'createPrompt' }
  | { kind: 'createFrom' }
  | { kind: 'existing'; branch: string }
  | { kind: 'remote'; remoteRef: string }
  | { kind: 'checkedOut'; branch: string; where: string };

export interface BranchPickEntry {
  label: string;
  description?: string;
  alwaysShow?: boolean;
  separator?: boolean;
  action?: BranchPickAction;
}

/**
 * Entries for the "new workstream" picker, modelled on VS Code's own branch picker:
 * create actions stay on top while typing, then local and remote branches.
 * `checkedOut` maps a local branch to the label of the worktree that has it checked out.
 */
export function branchPickEntries(typed: string, branches: BranchList, checkedOut: ReadonlyMap<string, string>): BranchPickEntry[] {
  const name = typed.trim();
  const entries: BranchPickEntry[] = [
    name && !branchNameProblem(name, branches.local)
      ? { label: `$(plus) Create new branch '${name}'`, alwaysShow: true, action: { kind: 'createNamed', branch: name } }
      : { label: '$(plus) Create new branch…', alwaysShow: true, action: { kind: 'createPrompt' } },
    { label: '$(plus) Create new branch from…', alwaysShow: true, action: { kind: 'createFrom' } },
  ];

  const localAction = (branch: string): BranchPickAction => {
    const where = checkedOut.get(branch);
    return where === undefined ? { kind: 'existing', branch } : { kind: 'checkedOut', branch, where };
  };
  const describe = (action: BranchPickAction) => (action.kind === 'checkedOut' ? `checked out in ${action.where}` : undefined);

  if (branches.local.length) {
    entries.push({ label: 'Branches', separator: true });
    for (const branch of branches.local) {
      const action = localAction(branch);
      entries.push({ label: `$(git-branch) ${branch}`, description: describe(action), action });
    }
  }
  if (branches.remote.length) {
    entries.push({ label: 'Remote branches', separator: true });
    for (const remoteRef of branches.remote) {
      const local = remoteRef.split('/').slice(1).join('/');
      const action: BranchPickAction = branches.local.includes(local) ? localAction(local) : { kind: 'remote', remoteRef };
      entries.push({ label: `$(cloud) ${remoteRef}`, description: describe(action), action });
    }
  }
  return entries;
}
