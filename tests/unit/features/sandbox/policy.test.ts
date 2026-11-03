import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  defaultPolicy,
  fixedFileRules,
  networkPolicy,
  openshellPolicy,
  PolicyStore,
  readPolicy,
  remoteHost,
  validatePolicy,
} from '../../../../src/features/sandbox/policy';
import { makeTempDir } from '../../../helpers/gitRepo';

describe('the security policy of sandboxed agents (BL-271)', () => {
  it("is strict by default: the system's folders to read, Claude's API and the git remote's host, for Claude, node and git", () => {
    const p = defaultPolicy({ host: 'github.com', port: 22 });
    expect(p.network).toEqual([
      { host: 'api.anthropic.com', port: 443 },
      { host: 'github.com', port: 22 },
    ]);
    expect(p.files.filter((r) => r.access === 'read-write').map((r) => r.path)).toEqual(['/sandbox', '/tmp', '/dev/null']);
    expect(p.commands.map((c) => c.path)).toContain('/usr/bin/git');
    expect(validatePolicy(p)).toEqual([]);
    expect(defaultPolicy().network).toEqual([{ host: 'api.anthropic.com', port: 443 }]);
  });

  it("finds the git remote's host in https, ssh and scp-like URLs", () => {
    expect(remoteHost('https://github.com/a/b.git')).toEqual({ host: 'github.com', port: 443 });
    expect(remoteHost('git@GitHub.com:a/b.git')).toEqual({ host: 'github.com', port: 22 });
    expect(remoteHost('ssh://git@git.example.org:2222/a/b')).toEqual({ host: 'git.example.org', port: 2222 });
    expect(remoteHost('/local/path')).toBeUndefined();
    expect(remoteHost(undefined)).toBeUndefined();
  });

  it('says which rule is wrong, and why, as OpenShell checks them', () => {
    const errors = validatePolicy({
      files: [
        { path: 'relative', access: 'read' },
        { path: '/', access: 'read' },
        { path: '/a/../b', access: 'read' },
        { path: '/ok', access: 'read' },
      ],
      network: [
        { host: 'registry.npmjs.org:abc', port: 443 },
        { host: 'ok.org', port: 0 },
      ],
      commands: [{ path: '/usr/bin/*' }],
    });
    expect(errors.map((e) => `${e.section}[${e.index}]`)).toEqual(['files[0]', 'files[1]', 'files[2]', 'network[0]', 'network[1]']);
    expect(errors[3].message).toContain('give the port in its own field');
    expect(validatePolicy({ files: [], network: [{ host: 'a.org', port: 1 }], commands: [] })).toEqual([
      expect.objectContaining({ section: 'commands', index: -1 }),
    ]);
  });

  it("makes OpenShell's policy from the user's rules and the mounts, and a network-only one to reload", () => {
    const yaml = openshellPolicy(defaultPolicy(), [{ path: '/repo' }, { path: '/tmp/flotilla', readOnly: true }], 1000, 1000);
    const [ro, rest] = yaml.split('read_write:');
    expect(ro).toContain('"/tmp/flotilla"');
    expect(ro).toContain('"/usr"');
    expect(ro).not.toContain('"/repo"');
    expect(rest).toContain('"/repo"');
    expect(rest).toContain('"/sandbox"');
    expect(yaml).toContain('run_as_user: "1000"');
    expect(yaml).toContain('- { host: "api.anthropic.com", port: 443 }');
    expect(yaml).toContain('- { path: "/usr/bin/git" }');
    expect(openshellPolicy(defaultPolicy(), [], 0, 0)).not.toContain('run_as_user');
    const net = networkPolicy(defaultPolicy());
    expect(net).toContain('network_policies:');
    expect(net).not.toContain('filesystem_policy');
  });

  it("shows Flotilla's own folders as fixed rows, each with its reason", () => {
    const rows = fixedFileRules({ agentDirs: ['/repo/.flotilla/backlog'], agentFiles: '/tmp/flotilla', configDir: '/home/u/.claude' });
    expect(rows.map((r) => r.path)).toContain('/repo/.flotilla/backlog');
    expect(rows.find((r) => r.path === '/tmp/flotilla')).toMatchObject({ access: 'read' });
    expect(rows.every((r) => r.reason)).toBe(true);
  });

  it('keeps one policy for all repositories, or this repository its own, and says which is in force', () => {
    const dir = makeTempDir();
    const store = new PolicyStore(path.join(dir, 'global'), path.join(dir, 'workspace'), () => defaultPolicy());
    expect(store.scope()).toBe('all');
    expect(store.saved()).toBe(false);
    expect(store.read()).toEqual(defaultPolicy());
    store.write('repository', { files: [], network: [{ host: 'a.org', port: 443 }], commands: [{ path: '/bin/curl' }] });
    expect(store.read().network).toEqual(defaultPolicy().network);
    store.setScope('repository');
    expect(store.scope()).toBe('repository');
    expect(store.read().network).toEqual([{ host: 'a.org', port: 443 }]);
    expect(store.file()).toBe(path.join(dir, 'workspace', 'security-policy.json'));
    fs.mkdirSync(store.globalDir, { recursive: true });
    fs.writeFileSync(store.file('all'), 'not json');
    expect(readPolicy(store.file('all'))).toBeUndefined();
    expect(new PolicyStore(path.join(dir, 'g'), undefined, () => defaultPolicy()).scope()).toBe('all');
  });
});
