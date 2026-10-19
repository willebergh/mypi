import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root mount point');
const renderer = createRoot(root);
renderer.render(<p role="status">Loading saved webcam preferences…</p>);
// No default scene/pose mounts or preference mutations before main's load ack.
if (typeof window.webcam?.getEditorSettings !== 'function') {
  renderer.render(<p role="alert">Persistent preferences require updated Electron main and preload. Load the updated app later; renderer HMR alone is insufficient.</p>);
} else {
  void window.webcam.getEditorSettings().then(initial => {
    renderer.render(<React.StrictMode><App initial={initial} /></React.StrictMode>);
  }).catch(() => renderer.render(<p role="alert">Could not load webcam preferences. Load updated Electron main and preload; no default settings have been saved.</p>));
}
