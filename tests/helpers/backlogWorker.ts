// Run as a child process by backlogConcurrency.test.ts (bundled first): adds tickets to a repository's backlog.
import { addItem } from '../../src/features/backlog/backlog';
import { LocalBacklog } from '../../src/features/backlog/localBacklog';

async function main(): Promise<void> {
  const [repo, count, tag] = process.argv.slice(2);
  const store = new LocalBacklog(repo, `${repo}/.git`);
  for (let i = 0; i < Number(count); i++) {
    await store.change((d) => addItem(d, `${tag} ${i}`, 'BL', new Date()).data);
  }
}

void main();
