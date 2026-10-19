import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
if (process.platform !== 'darwin') throw new Error('Camera extension tests require macOS');
const root = fileURLToPath(new URL('.', import.meta.url));
const output = path.join(root, 'build');
mkdirSync(output, { recursive: true });
const executable = path.join(output, 'frame-tests');
execFileSync('xcrun', ['swiftc', '-O', '-swift-version', '6', '-warnings-as-errors', '-parse-as-library', '-emit-executable',
  ...['extension/TestPattern.swift', 'extension/FramePump.swift', 'extension/test/FrameTests.swift'].map(name => path.join(root, name)),
  '-o', executable], { stdio: 'inherit' });
// This is a buffer/timer harness, NOT the CMIO provider executable. No device registration.
execFileSync(executable, ['--self-test'], { stdio: 'inherit' });
