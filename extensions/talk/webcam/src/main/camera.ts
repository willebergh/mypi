import { app } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { CameraStatus } from '../shared/types';

interface CameraManager {
  initialize(): CameraStatus;
  status(): CameraStatus;
  refresh(): CameraStatus;
  activate(): CameraStatus;
  deactivate(): CameraStatus;
}
let manager: CameraManager | null = null;
let loadError = '';
export function cameraStatus(action: 'status' | 'refresh' | 'activate' | 'deactivate' = 'status'): CameraStatus {
  if (process.platform !== 'darwin') return unavailable('Camera extensions require macOS 12.3 or later.');
  try {
    if (!manager) {
      const filename = app.isPackaged ? path.join(process.resourcesPath, 'camera_manager.node')
        : path.join(app.getAppPath(), 'native/macos/camera/manager/build/Release/camera_manager.node');
      manager = createRequire(__filename)(filename) as CameraManager;
      manager.initialize();
    }
    return manager[action]();
  } catch (error) {
    loadError = String(error);
    return unavailable('Build the native camera components with pnpm camera:build, then restart the app.');
  }
}
function unavailable(instructions: string): CameraStatus {
  return { bundled: false, canRequest: false, installation: 'unknown', activation: 'unknown',
    requestState: 'unavailable', teamID: '', error: loadError, instructions };
}
