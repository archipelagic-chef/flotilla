import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  dispatchInputs,
  GitHubActions,
  isDispatchable,
} from '../../../../src/features/ci/githubActions';
import type { Fetch } from '../../../../src/features/backlog/sources/source';

describe('dispatchInputs', () => {
  it('reads string inputs with their description, default and required flag', () => {
    const yaml = `
on:
  workflow_dispatch:
    inputs:
      environment:
        description: 'Where to deploy'
        required: true
        default: "staging"
      tag:
        description: Release tag
        type: string
`;
    expect(dispatchInputs(yaml)).toEqual([
      { name: 'environment', description: 'Where to deploy', type: 'string', required: true, default: 'staging' },
      { name: 'tag', description: 'Release tag', type: 'string', required: false },
    ]);
  });

  it('reads choices, as a block list and as a flow list', () => {
    const yaml = `
on:
  workflow_dispatch:
    inputs:
      region:
        type: choice
        options:
          - eu
          - us
        default: us
      size:
        type: choice
        options: [small, "large"]
`;
    const [region, size] = dispatchInputs(yaml);
    expect(region).toMatchObject({ name: 'region', type: 'choice', options: ['eu', 'us'], default: 'us', required: false });
    expect(size).toMatchObject({ name: 'size', type: 'choice', options: ['small', 'large'], required: false });
  });

  it('reads boolean inputs and their defaults', () => {
    const yaml = `
on:
  workflow_dispatch:
    inputs:
      dry_run:
        type: boolean
        default: true
`;
    expect(dispatchInputs(yaml)).toEqual([{ name: 'dry_run', type: 'boolean', required: false, default: 'true' }]);
  });

  it('gives no inputs for a workflow without any', () => {
    expect(dispatchInputs('on:\n  workflow_dispatch:\njobs:\n  build:\n    runs-on: ubuntu-latest\n')).toEqual([]);
    expect(dispatchInputs('on: push\n')).toEqual([]);
  });

  it('ignores inputs of another trigger, and of jobs', () => {
    const yaml = `
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  deploy:
    steps:
      - uses: some/action
        with:
          inputs:
            name: value
`;
    expect(dispatchInputs(yaml)).toEqual([]);
  });

  it('skips comments and keeps the input names as written', () => {
    const yaml = `
on:
  workflow_dispatch:
    inputs:
      # the release to cut
      release_name:
        # shown in the prompt
        description: Name
        required: true
`;
    expect(dispatchInputs(yaml)).toEqual([{ name: 'release_name', description: 'Name', type: 'string', required: true }]);
  });
});

describe('isDispatchable', () => {
  it('is true for a workflow_dispatch trigger, alone or in a list', () => {
    expect(isDispatchable('on:\n  workflow_dispatch:\n')).toBe(true);
    expect(isDispatchable('on: [push, workflow_dispatch]\n')).toBe(true);
  });

  it('ignores the word in a step, a name or a comment: only a trigger in the on: block counts', () => {
    const yaml = [
      'name: workflow_dispatch demo',
      'on: push',
      'jobs:',
      '  build:',
      '    steps:',
      '      - run: echo "workflow_dispatch:"',
      '        name: workflow_dispatch',
      '      - uses: some/action',
      '        with:',
      '          workflow_dispatch: true',
    ].join('\n');
    expect(isDispatchable(yaml)).toBe(false);
    expect(isDispatchable('on: push # workflow_dispatch\n')).toBe(false);
  });

  it('is false without one, or when it is only in a comment', () => {
    expect(isDispatchable('on: push\n')).toBe(false);
    expect(isDispatchable('on:\n  push:\n  # workflow_dispatch: later\n')).toBe(false);
  });
});

describe('GitHubActions.branchHead', () => {
  it("reads the branch's head SHA from GitHub, with a slash in the branch name kept as a path", async () => {
    const urls: string[] = [];
    const fetch: Fetch = async (url) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ commit: { sha: 'f00dfeed'.repeat(5) } }),
        text: async () => JSON.stringify({ commit: { sha: 'f00dfeed'.repeat(5) } }),
      };
    };
    const sha = await new GitHubActions('acme', 'shop', async () => 'tok', fetch).branchHead('feat/x y');
    expect(sha).toBe('f00dfeed'.repeat(5));
    expect(urls).toEqual(['https://api.github.com/repos/acme/shop/branches/feat/x%20y']);
  });
});

describe('GitHubActions.dispatch', () => {
  it('starts the workflow on the ref, with the inputs, and reads the empty 204 answer', async () => {
    const calls: Array<{ url: string; method?: string; body?: string; auth?: string }> = [];
    const fetch: Fetch = async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body, auth: init?.headers?.Authorization });
      return { ok: true, status: 204, statusText: 'No Content', json: async () => undefined, text: async () => '' };
    };
    const client = new GitHubActions('acme', 'shop', async () => 'tok', fetch);
    await client.dispatch(42, 'feat/x', { environment: 'prod' });
    expect(calls).toEqual([
      {
        url: 'https://api.github.com/repos/acme/shop/actions/workflows/42/dispatches',
        method: 'POST',
        body: JSON.stringify({ ref: 'feat/x', inputs: { environment: 'prod' } }),
        auth: 'Bearer tok',
      },
    ]);
  });
});
