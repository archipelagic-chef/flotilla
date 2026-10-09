import type { AgentState } from '../features/workstreams/agentStatus';

/**
 * Runs as `node -e "<script>" <state>`. It must not contain characters that cmd, PowerShell or sh
 * interpret inside double quotes: " $ ` ! % ^ < > &.
 */
export const HOOK_SCRIPT = [
  'try{',
  "const f=require('fs'),p=require('path'),c=require('child_process');",
  "let i={};try{i=JSON.parse(f.readFileSync(0,'utf8'))}catch(e){}",
  "const m=String(i.message||i.prompt||'').slice(0,120);",
  "const d=c.execSync('git rev-parse --git-dir',{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();",
  "f.writeFileSync(p.join(d,'workstream.json'),JSON.stringify({state:process.argv[1],message:m||undefined,updatedAt:new Date().toISOString()}))",
  '}catch(e){}',
].join('');

export function claudeHookCommand(state: AgentState): string {
  return `node -e "${HOOK_SCRIPT}" ${state}`;
}

export function claudeHookConfig(): string {
  const entry = (state: AgentState) => [{ hooks: [{ type: 'command', command: claudeHookCommand(state) }] }];
  return JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: entry('working'),
        PostToolUse: entry('working'),
        Notification: entry('waiting-for-input'),
        Stop: entry('done'),
      },
    },
    null,
    2,
  );
}
