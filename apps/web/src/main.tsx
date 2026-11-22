import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import './styles/index.css';
import { App } from './App.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// ponytail: register SW only on https; Chrome Android requires it for installability
// but no value intercepting vite dev HMR over http.
if (
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  window.location.protocol === 'https:'
) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
