import * as vscode from 'vscode';
import { type AgentChoice, type BacklogItem } from '../../../features/backlog/backlog';
import { validModel } from '../agentRunner';
import type { Handlers } from './context';
import type { AgentsMessage } from './agents.messages';

/** An item with its agent choice (none, when all are the defaults). A model chosen replaces Light, and Light a model. */
function withAgent(item: BacklogItem, agent: AgentChoice): BacklogItem {
  const { agent: _old, ...rest } = item;
  const clean: AgentChoice = {
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.effort ? { effort: agent.effort } : {}),
    ...(agent.light && !agent.model ? { light: true } : {}),
    ...(agent.movedUp ? { movedUp: agent.movedUp } : {}),
  };
  return Object.keys(clean).length ? { ...rest, agent: clean } : rest;
}

/** The ticket's agents: starting one, pausing or stopping it, the model and effort they use, and their chats. */
export const agentsHandlers: Handlers<AgentsMessage> = {
  start: async ({ id }, m) => {
    await vscode.commands.executeCommand('flotilla.startBacklogItem', id, { agent: m.agent, ...(m.newWorktree ? { newWorktree: m.newWorktree } : {}) });
  },
  agentModel: async ({ id, item, backlog }, m) => {
    if (item.remote) return;
    let model = m.model?.trim() || undefined;
    if (model === 'other') {
      model = (
        await vscode.window.showInputBox({
          title: `The model for agents on ${id}`,
          prompt: "An alias (opus, sonnet, haiku, fable) or a model's full name (claude-opus-5-5)",
          value: item.agent?.model ?? '',
        })
      )?.trim();
      if (model === undefined) return;
    }
    if (model === 'light') {
      await backlog.change((d) => ({ ...d, items: d.items.map((i) => (i.id === id ? withAgent(i, { ...i.agent, model: undefined, light: true }) : i)) }));
      return;
    }
    if (model && !validModel(model)) {
      void vscode.window.showWarningMessage(`"${model}" isn't a model name: an alias (opus, sonnet…) or a model's id (letters, digits, dots and dashes).`);
      return;
    }
    await backlog.change((d) => ({
      ...d,
      items: d.items.map((i) => (i.id === id ? withAgent(i, { ...i.agent, model: model || undefined, light: false }) : i)),
    }));
  },
  agentEffort: async ({ id, item, backlog }, m) => {
    if (item.remote) return;
    await backlog.change((d) => ({ ...d, items: d.items.map((i) => (i.id === id ? withAgent(i, { ...i.agent, effort: m.effort ?? undefined }) : i)) }));
  },
  agent: async ({ id, panels }, m) => {
    await panels.controlAgent(id, m.action, m.session);
  },
  summarize: async ({ id, panels }, m) => panels.summarize(id, m.session),
  openChat: async ({ item, backlog, panels }, m) => {
    // Any chat the ticket lists opens, in whichever worktree it ran (BL-131): not only the ticket's own.
    const listed = panels.agentChats(item, (await backlog.readTicket(item)).activity).some((c) => c.key === m.key && c.id === m.id);
    if (listed) await vscode.commands.executeCommand('flotilla.openChat', { key: m.key, chatId: m.id });
    else void vscode.window.showWarningMessage(`Can't open this chat: it's no longer among ${item.id}'s chats (its worktree may have been removed).`);
  },
};
