import * as vscode from 'vscode';
import {
  AGENT_EFFORTS,
  AGENT_MODELS,
  type AgentEffort,
  defaultsLabel,
} from '../../features/backlog/backlog';
import { agentChoice, validModel } from './agentRunner';

/**
 * Saves one part of the agents' default (flotilla.agents.model or .effort): in the workspace's settings when a folder
 * is open, else in the user's. Empty unsets it (Claude Code's default). Where it saved, or undefined when the value was
 * refused (not a model's name, not an effort).
 */
export async function saveAgentDefault(part: 'model' | 'effort', value: string | undefined): Promise<'workspace' | 'user' | undefined> {
  const v = value?.trim() || undefined;
  if (v && (part === 'model' ? !validModel(v) : !AGENT_EFFORTS.includes(v as AgentEffort))) return undefined;
  const workspace = !!vscode.workspace.workspaceFolders?.length;
  await vscode.workspace
    .getConfiguration('flotilla')
    .update(`agents.${part}`, v, workspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
  return workspace ? 'workspace' : 'user';
}

const mark = (on: boolean) => (on ? '$(check) ' : '$(blank) ');

/**
 * The agents' default model, then effort, in two quick picks (BL-242): for every ticket that hasn't chosen its own.
 * Escape in the model's changes nothing; in the effort's, keeps the effort.
 */
export async function chooseAgentDefaults(): Promise<void> {
  const config = vscode.workspace.getConfiguration('flotilla');
  const current = { model: config.get<string>('agents.model', '').trim(), effort: config.get<string>('agents.effort', '').trim() };
  const custom = current.model && !AGENT_MODELS.some((m) => m.model === current.model.toLowerCase()) ? [current.model] : [];
  type Pick = vscode.QuickPickItem & { value: string };
  const models: Pick[] = [
    { label: `${mark(!current.model)}Claude Code's default`, value: '' },
    ...AGENT_MODELS.map((m) => ({ label: `${mark(current.model.toLowerCase() === m.model)}${m.label}`, description: m.detail, value: m.model })),
    ...custom.map((c) => ({ label: `${mark(true)}${c}`, value: c })),
    { label: '$(edit) Other Model…', value: 'other' },
  ];
  const model = await vscode.window.showQuickPick(models, {
    title: "Agents' default model (1/2)",
    placeHolder: "For every ticket that hasn't chosen its own; Light tickets keep the light model",
  });
  if (!model) return;
  let name: string | undefined = model.value;
  if (name === 'other') {
    name = (
      await vscode.window.showInputBox({
        title: "Agents' default model",
        prompt: "An alias (opus, sonnet, haiku, fable) or a model's full name (claude-opus-5-5)",
        value: current.model,
        validateInput: (v) => (!v.trim() || validModel(v.trim()) ? undefined : "Not a model's name: letters, digits, dots and dashes"),
      })
    )?.trim();
    if (name === undefined) return;
  }
  const where: string[] = [];
  if (name !== current.model) {
    const saved = await saveAgentDefault('model', name);
    if (!saved) return void vscode.window.showWarningMessage(`"${name}" isn't a model name: an alias (opus, sonnet…) or a model's id.`);
    where.push(saved);
  }
  const efforts: Pick[] = [
    { label: `${mark(!current.effort)}Claude Code's default`, value: '' },
    ...AGENT_EFFORTS.map((e) => ({ label: `${mark(current.effort === e)}${e[0].toUpperCase()}${e.slice(1)}`, value: e })),
  ];
  const effort = await vscode.window.showQuickPick(efforts, { title: "Agents' default effort (2/2)", placeHolder: 'How hard they think' });
  if (effort && effort.value !== current.effort) {
    const saved = await saveAgentDefault('effort', effort.value);
    if (saved) where.push(saved);
  }
  if (!where.length) return;
  const settings = where[0] === 'workspace' ? "this workspace's settings" : 'your user settings';
  void vscode.window.showInformationMessage(
    `Agents now default to ${defaultsLabel(agentChoice(undefined))}: saved in ${settings} (flotilla.agents.model, .effort).`,
  );
}
