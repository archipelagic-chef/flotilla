import * as vscode from 'vscode';
import { shortTime } from '../../webview/shortTime';
import {
  type Commands,
  showError,
} from '../commandSet';
import type { Autopilot } from './autopilot';
import type { PauseAll } from './pauseAll';

/** The autopilot's commands: turn it on or off, try the agents a usage limit paused, Pause All and Resume All. */
export function autopilotCommands(deps: { autopilot: Autopilot; pauseAll: PauseAll }): Commands {
  const { autopilot, pauseAll } = deps;
  return {
    'flotilla.toggleAutopilot': async () => {
      const on = !autopilot.enabled;
      // Turning it off stops no agent: say so first, while any work (BL-153).
      const working = on ? 0 : autopilot.view().running;
      if (working) {
        const off = 'Turn Off';
        const pick = await vscode.window.showWarningMessage(
          `Turn the autopilot off? ${working === 1 ? 'The agent working keeps working' : `${working} agents keep working`}; no new tickets start.`,
          { modal: true },
          off,
        );
        if (pick !== off) return;
      }
      await autopilot.setEnabled(on);
      if (on) {
        void vscode.window.showInformationMessage(
          `Autopilot on: up to ${autopilot.view().max} agents take To Do tickets from the top of the backlog and work on them without a window. They report in the tickets; their work goes on to review.`,
        );
      }
    },
    'flotilla.tryPausedNow': async () => {
      // With the autopilot off too: it resumes the paused agents, and starts no new tickets.
      const result = await autopilot.tryNow();
      if (!result) void vscode.window.showInformationMessage('No agent waits for a usage limit.');
      else if (result.limited)
        void vscode.window.showInformationMessage(`Claude is still limited: no agent was started. They go on by themselves at ${shortTime(result.limited)}.`);
      else
        void vscode.window.showInformationMessage(
          `Claude takes work again: ${result.resumed === 1 ? 'the paused agent goes on' : `${result.resumed} paused agents go on, top of the backlog first`}.`,
        );
    },
    'flotilla.pauseAllAgents': () => pauseAll.pauseCommand().catch(showError),
    'flotilla.resumeAllAgents': () => pauseAll.resumeCommand().catch(showError),
  };
}
