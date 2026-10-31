import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import { agentChatItem } from '../../features/backlog/backlog';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import { levelReport } from '../../features/backlog/modelLevel';
import type { Workstream } from '../../features/workstreams/workstream';
import { modelLevels } from '../backlog/agentRunner';
import {
  type Commands,
  showError,
} from '../commandSet';
import type { ImprovementReview } from './improvementReview';
import type { Metrics } from './metrics';

export interface MetricsCommandDeps {
  backlog: LocalBacklog;
  repository: Repository<Workstream>;
  metrics: Metrics;
  improvement: ImprovementReview;
  output: vscode.OutputChannel;
}

/** The metrics' commands: the Metrics view (BL-158), the improvement review (BL-159), and how finished tickets fared per model level (BL-69). */
export function metricsCommands(deps: MetricsCommandDeps): Commands {
  const { backlog, repository, metrics, improvement, output } = deps;
  return {
    'flotilla.openMetrics': () => metrics.openEditor('week'),
    'flotilla.reviewImprovementsNow': () => improvement.reviewNow().catch(showError),
    'flotilla.openImprovementReview': () => improvement.openLatest().catch(showError),
    'flotilla.modelLevelReport': async () => {
      // What each ticket's agents re-read, from their chats still around.
      const reRead = new Map<string, number>();
      for (const c of repository.current.flatMap((w) => w.chats)) {
        const item = agentChatItem(c.firstPrompt)?.item;
        if (item && c.usage) reRead.set(item, (reRead.get(item) ?? 0) + c.usage.reRead);
      }
      output.appendLine(levelReport((await backlog.read()).items, modelLevels(), reRead).join('\n'));
      output.show(true);
    },
  };
}
