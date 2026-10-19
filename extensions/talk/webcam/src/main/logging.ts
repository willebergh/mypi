import { app } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

function brokenPipe(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'EPIPE';
}
// A dev launcher/terminal can disappear while Electron is still alive. A closed
// log pipe must not turn a handled IPC rejection into an uncaught main-process error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', error => { if (!brokenPipe(error)) throw error; });
}
for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    if (method === 'error') {
      try {
        const directory = app.getPath('userData');
        mkdirSync(directory, { recursive: true });
        appendFileSync(path.join(directory, 'main-errors.log'), `${new Date().toISOString()} ${format(...args)}\n`);
      } catch { /* Logging must not replace the original error if the log directory is unavailable. */ }
    }
    try { original(...args); }
    catch (error) { if (!brokenPipe(error)) throw error; }
  };
}
