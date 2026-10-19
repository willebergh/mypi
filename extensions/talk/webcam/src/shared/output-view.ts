export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}
export type OutputViewMode = 'hero' | 'follow-editor' | 'custom';
export interface OutputViewState { mode: OutputViewMode; pose: CameraPose | null; revision: number }
export interface OutputViewRequest { mode: OutputViewMode; pose?: CameraPose }
/** Sample of the actual hidden output renderer, not another Three.js simulation.
 * It monitors the camera-source image, not receiver-side FaceTime crop/processing.
 */
export interface OutputPreviewFrame {
  dataUrl: string;
  width: number;
  height: number;
  sequence: number;
  timestamp: number;
}
export function validateCameraPose(value: unknown): CameraPose {
  if (!value || typeof value !== 'object') throw new Error('Invalid camera pose');
  const input = value as Record<string, unknown>;
  const vector = (value: unknown): [number, number, number] => {
    if (!Array.isArray(value) || value.length !== 3 || value.some(n => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 30)) throw new Error('Invalid camera coordinates');
    return [...value] as [number, number, number];
  };
  const position = vector(input.position), target = vector(input.target);
  const distance = Math.hypot(...position.map((n, i) => n - target[i]));
  if (distance < .1 || distance > 35 || typeof input.fov !== 'number' || !Number.isFinite(input.fov) || input.fov < 10 || input.fov > 100) throw new Error('Invalid camera framing');
  return { position, target, fov: input.fov };
}
export function validateOutputViewRequest(value: unknown): OutputViewRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid output view');
  const input = value as Record<string, unknown>;
  if (input.mode === 'hero') return { mode: 'hero' };
  if (input.mode !== 'follow-editor' && input.mode !== 'custom') throw new Error('Invalid output view mode');
  return { mode: input.mode, pose: validateCameraPose(input.pose) };
}
