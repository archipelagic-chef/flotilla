import { render } from 'preact';
import {
  useEffect,
  useState,
} from 'preact/hooks';
import type {
  RuleError,
  SecurityHostMessage,
  SecurityView,
  SecurityWebviewMessage,
} from '../securityProtocol';
import { SecurityBody } from './view';

interface VsCodeApi {
  postMessage(message: SecurityWebviewMessage): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

/** The Security panel in its editor tab (BL-271): the host's policy, edited here until it's saved. */
function App() {
  const [view, setView] = useState<SecurityView | undefined>();
  const [errors, setErrors] = useState<RuleError[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const on = (e: MessageEvent<SecurityHostMessage>) => {
      setSaving(false);
      if (e.data.type === 'securityView') {
        setView(e.data.view);
        setErrors([]);
      } else if (e.data.type === 'securityErrors') setErrors(e.data.errors);
    };
    window.addEventListener('message', on);
    vscode.postMessage({ type: 'securityReady' });
    return () => window.removeEventListener('message', on);
  }, []);
  if (!view) return <div class="security">Loading…</div>;
  return (
    <SecurityBody
      view={view}
      errors={errors}
      saving={saving}
      save={(policy) => {
        setSaving(true);
        vscode.postMessage({ type: 'securitySave', policy });
      }}
      setScope={(scope) => vscode.postMessage({ type: 'securityScope', scope })}
      enableSandbox={() => vscode.postMessage({ type: 'securityEnableSandbox' })}
    />
  );
}

render(<App />, document.getElementById('root')!);
