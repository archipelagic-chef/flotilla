/** What the CI/CD view can do to a run. */
export type RunAction = 'rerun' | 'rerunFailed' | 'cancel';

/** Which actions a run offers: re-runs once it has finished, cancel while it's queued or running. */
export function runActions(run: { active: boolean; failed: boolean }): RunAction[] {
  if (run.active) return ['cancel'];
  return run.failed ? ['rerun', 'rerunFailed'] : ['rerun'];
}

/** GitHub's answer to a run action that didn't work, as the message the user sees (what to do next). */
export function explainRunError(action: RunAction, status: number, detail: string, repo: string): string {
  const name = action === 'cancel' ? 'cancel' : 're-run';
  switch (status) {
    case 401:
      return `GitHub doesn't accept the sign-in any more. Sign in to GitHub again and retry the ${name}.`;
    case 403:
      if (/old|days|expired|deleted|not allowed/i.test(detail)) {
        return `GitHub won't ${name} this run: it's too old, or its logs were deleted. Start a new run instead: push a commit, or run the workflow by hand.`;
      }
      return `Flotilla's GitHub sign-in may not ${name} workflow runs in ${repo}. Check that you have write access to the repository and that the sign-in has the repo scope, then retry.`;
    case 404:
      return `GitHub doesn't find this run in ${repo}: it may have been deleted, or the sign-in has no access to the repository.`;
    case 409:
      return action === 'cancel'
        ? `This run has already finished, so there's nothing to cancel. Refresh the view to see its result.`
        : `GitHub can't ${name} this run yet: it's still running. Wait until it finishes, then retry.`;
    case 422:
      return `GitHub can't re-run the failed jobs: no job in this run failed. Use Re-run to run it all again.`;
    default:
      return `GitHub didn't ${name} the run (${status}${detail ? `: ${detail}` : ''}). Try again in a moment.`;
  }
}
