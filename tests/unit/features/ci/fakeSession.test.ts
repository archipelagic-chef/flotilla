import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const vs = vi.hoisted(() => ({ signedOut: false }));

vi.mock('vscode', () => ({
  EventEmitter: class {
    private listeners: (() => void)[] = [];
    event = (l: () => void) => {
      this.listeners.push(l);
      return { dispose: () => undefined };
    };
    fire() {
      for (const l of this.listeners) l();
    }
    dispose() {}
  },
  workspace: { getConfiguration: () => ({ get: (key: string, fallback: unknown) => (key === 'dev.githubSignedOut' ? vs.signedOut : fallback) }) },
  authentication: { getSession: vi.fn() },
}));

import { FakeGitHubSession, fakeGitHubSession } from '../../../../src/features/ci/fakeSession';
import { signedInPullRequests } from '../../../../src/features/ci/jobLog';
import { GitHubSignInNeeded } from '../../../../src/features/ci/pullRequests';

describe('the fake GitHub signed out (BL-245)', () => {
  it('is signed in unless the setting starts it signed out', () => {
    vs.signedOut = false;
    expect(new FakeGitHubSession().signedIn).toBe(true);
    vs.signedOut = true;
    expect(new FakeGitHubSession().signedIn).toBe(false);
  });

  it('signs in once, and says so', () => {
    vs.signedOut = true;
    const session = new FakeGitHubSession();
    const changed = vi.fn();
    session.onDidChange(changed);
    session.signIn();
    session.signIn();
    expect(session.signedIn).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('has the pull requests client ask for a sign-in until it signs in', async () => {
    vs.signedOut = true;
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => [], text: async () => '[]', headers: { get: () => null } }));
    const prs = signedInPullRequests(fetch as never, 'http://127.0.0.1:4010')('octo', 'repo');
    await expect(prs.files(1)).rejects.toBeInstanceOf(GitHubSignInNeeded);
    expect(fetch).not.toHaveBeenCalled();
    fakeGitHubSession.signIn();
    await expect(prs.files(1)).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalled();
  });
});
