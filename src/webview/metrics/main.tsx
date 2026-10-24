import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { MetricsHostMessage, MetricsPeriod, MetricsView, MetricsWebviewMessage } from '../metricsProtocol';
import { MetricsBody } from './view';

interface VsCodeApi {
  postMessage(message: MetricsWebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

/** The Metrics view in its editor tab (BL-158): the period it was opened on, then the one picked here. */
function App() {
  const [period, setPeriod] = useState<MetricsPeriod>(((vscode.getState() as { period?: MetricsPeriod } | undefined)?.period ?? document.body.dataset.period ?? 'week') as MetricsPeriod);
  const [view, setView] = useState<MetricsView | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    const on = (e: MessageEvent<MetricsHostMessage>) => {
      if (e.data.type === 'metricsView') {
        setView(e.data.view);
        setPeriod(e.data.view.period);
        setError(undefined);
      } else if (e.data.type === 'metricsError') setError(e.data.message);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);
  useEffect(() => {
    vscode.setState({ period });
    vscode.postMessage({ type: 'metrics', period });
  }, [period]);
  return <MetricsBody view={view?.period === period ? view : undefined} error={error} period={period} setPeriod={setPeriod} openTicket={(ticket) => vscode.postMessage({ type: 'metricsOpen', ticket })} wide />;
}

render(<App />, document.getElementById('root')!);
