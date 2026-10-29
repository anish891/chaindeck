// Everything the Node tests need from the app, in one place. The tests build this file with Vite (see
// api/lib/paperUi.js), so it is compiled and bundled exactly as the real app is. It is never part of the shipped bundle.
export * from './format';
export * from './payoff';
export * from './ticket';
export * from './strategy';
export * from './api';
export { niceTicks } from './components/LineChart';
export { agentPrompt } from './components/AccountsPanel';
export { previousClose } from './components/Strip';
export { App } from './App';
export { Chain } from './components/Chain';
export { OrderSheet } from './components/OrderSheet';
export { Blotter } from './components/Blotter';
export { Strip } from './components/Strip';
export { PayoffPanel, EquityPanel } from './components/ChartPanels';
export { AccountsPanel } from './components/AccountsPanel';
export { Perf } from './components/Perf';
export { Report } from './lab/Report';
export { Deployments } from './lab/Deployments';
export { StrategyEditor } from './lab/StrategyEditor';
export { LineChart } from './components/LineChart';
export { NumField } from './components/NumField';
export { renderToStaticMarkup } from 'react-dom/server';
export { createElement } from 'react';
