/**
 * What agents are told about a tidy, linear history (BL-181), and how tickets land (flotilla.merge.style). Plain text and
 * types only: the webview's bundle takes it too (linearHistory.ts has the git side).
 */

/** How a ticket's work lands on the base: main fast-forwards to the (rebased) branch, or a merge commit is made. */
export type MergeStyle = 'fast-forward' | 'merge-commit';

export function mergeStyle(value: unknown): MergeStyle {
  return value === 'merge-commit' ? 'merge-commit' : 'fast-forward';
}

/** How an agent keeps its branch current and tidies it before it reports (the prompts' text). */
export function tidyNotes(id: string): string {
  return `Keep your branch current by rebasing it onto main (\`git rebase main\`, the branch work merges into), never by merging main into it: resolve any conflicts during the rebase, commit by commit (\`git add\` the files, then \`GIT_EDITOR=true git rebase --continue\`). Then tidy your commits into the steps a reviewer would want to read, non-interactively: \`fixup!\` commits and \`GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash main\`, or \`git rebase -i main\` with a scripted \`GIT_SEQUENCE_EDITOR\` that squashes, reorders and rewords. Make each commit one step that builds and passes on its own where reasonable, each message starting with "${id}: ", with no "Merge main" and no "fix typo" commits. Say in your report how many commits you made from how many. Your branch is rewritten, so if you ever push it, push with \`git push --force-with-lease\`; never force-push anything else.`;
}

/** How an agent makes the changes a review asked for: fixup! commits the reviewer can read, squashed later. */
export function fixupNote(id: string): string {
  return `Make the changes as \`fixup!\` commits of the commits they change (\`git commit --fixup <commit>\`), so the reviewer sees what changed, and leave them in for this review: they're squashed in your next tidy-up (\`GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash main\`), or when ${id} lands.`;
}
