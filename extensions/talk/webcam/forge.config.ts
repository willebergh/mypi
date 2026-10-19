import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    appBundleId: 'com.pitalk.webcam',
    extendInfo: { CFBundleDisplayName: 'Pi Talk Webcam',
      NSMicrophoneUsageDescription: 'Animate the robot mouth from the fixed Pi Talk virtual agent-speech input while this app runs. No physical microphone or caller audio is selected.' },
    extraResource: process.platform === 'darwin' ? [
      'native/macos/build/Release/bridge.node',
      'native/macos/audio/build/Release/pitalk_audio.node',
      'native/macos/camera/manager/build/Release/camera_manager.node',
    ] : [],
  },
  hooks: {
    generateAssets: async (_config, platform, arch) => {
      if (platform === 'darwin' && (platform !== process.platform || arch !== process.arch)) {
        throw new Error('The Metal bridge currently requires a native host build for the target architecture');
      }
      execFileSync(process.execPath, ['native/build.mjs'], { stdio: 'inherit' });
      if (platform === 'darwin') execFileSync(process.execPath, ['native/macos/audio/build.mjs'], { stdio: 'inherit' });
      execFileSync(process.execPath, ['native/macos/camera/build.mjs'], { stdio: 'inherit' });
    },
    postPackage: async (_config, result) => {
      if (result.platform !== 'darwin') return;
      for (const output of result.outputPaths) {
        const destination = path.join(output, 'pi-talk-webcam.app/Contents/Library/SystemExtensions');
        mkdirSync(destination, { recursive: true });
        cpSync('native/macos/camera/build/com.pitalk.webcam.camera.systemextension',
          path.join(destination, 'com.pitalk.webcam.camera.systemextension'), { recursive: true });
      }
      // All components are assembled BEFORE the separate explicit camera:sign step.
      console.log('Camera bundled UNSIGNED. Signing/provisioning and /Applications installation are required; see native/macos/camera/README.md.');
    },
  },
  plugins: [new VitePlugin({
    build: [
      { entry: 'src/main/index.ts', config: 'vite.main.config.ts', target: 'main' },
      { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts', target: 'preload' },
    ],
    renderer: [{ name: 'app', config: 'vite.renderer.config.ts' }],
  })],
};
export default config;
