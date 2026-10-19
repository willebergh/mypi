import { DEFAULT_SCENE_CONFIG, SCENE_RANGES, validateSceneConfig, type SceneConfig } from './scene-config.ts';
import { validateCameraPose, validateOutputViewRequest, type CameraPose, type OutputViewRequest } from './output-view.ts';
import type { SceneState } from './scene-config.ts';

export const SETTINGS_VERSION = 1;
export const MAX_SETTINGS_BYTES = 64 * 1024;
export interface EditorPreferences {
  visibleViews: 'editor' | 'output' | 'both';
  inspectorSection: 'Scene' | 'Character' | 'Overlay';
}
export interface EditorBounds { x: number; y: number; width: number; height: number }
export interface AppSettings {
  version: typeof SETTINGS_VERSION;
  scene: SceneConfig;
  outputView: OutputViewRequest;
  editorPose: CameraPose | null;
  editor: EditorPreferences;
  windowBounds: EditorBounds | null;
  hudSource: 'live' | 'demo';
  /** Explicit user stop latch, not the current renderer/transport state. */
  outputStopped: boolean;
}
export interface SettingsStatus { filePath: string; warning: string | null; readOnly: boolean }
export interface EditorBootstrap {
  scene: SceneState;
  editor: EditorPreferences;
  editorPose: CameraPose | null;
  settings: SettingsStatus;
}
export function defaultSettings(): AppSettings {
  return { version: SETTINGS_VERSION, scene: { ...DEFAULT_SCENE_CONFIG }, outputView: { mode: 'hero' },
    editorPose: null, editor: { visibleViews: 'editor', inspectorSection: 'Scene' },
    windowBounds: null, hudSource: 'live', outputStopped: false };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Expected settings object');
  return value as Record<string, unknown>;
}
const has = (value: object, key: string) => Object.hasOwn(value, key);

/** Strict, small editor-only IPC DTO. No scene, paths, runtime state or arbitrary keys. */
export function validateEditorPreferences(value: unknown, previous: EditorPreferences): EditorPreferences {
  const input = record(value), result = { ...previous };
  if (!Object.keys(input).length || Object.keys(input).some(key => key !== 'visibleViews' && key !== 'inspectorSection')) throw new Error('Invalid editor preference');
  if (has(input, 'visibleViews')) {
    if (!['editor', 'output', 'both'].includes(input.visibleViews as string)) throw new Error('Invalid workspace view');
    result.visibleViews = input.visibleViews as EditorPreferences['visibleViews'];
  }
  if (has(input, 'inspectorSection')) {
    if (!['Scene', 'Character', 'Overlay'].includes(input.inspectorSection as string)) throw new Error('Invalid inspector section');
    result.inspectorSection = input.inspectorSection as EditorPreferences['inspectorSection'];
  }
  return result;
}
function bounds(value: unknown): EditorBounds {
  const input = record(value);
  for (const key of ['x', 'y', 'width', 'height']) {
    if (typeof input[key] !== 'number' || !Number.isInteger(input[key]) || Math.abs(input[key] as number) > 100_000) throw new Error('Invalid editor bounds');
  }
  return { x: input.x as number, y: input.y as number,
    width: Math.max(1000, Math.min(3840, input.width as number)), height: Math.max(720, Math.min(2160, input.height as number)) };
}

/** Partial old documents acquire new defaults. Unknown fields are ignored, never copied.
 * Version 0/unversioned sceneConfig documents are the only legacy document shape.
 * Existing numeric scene limits and camera validation remain authoritative.
 */
export function validateSettings(value: unknown): AppSettings {
  const input = record(value), result = defaultSettings();
  if (has(input, 'version') && input.version !== 0 && input.version !== SETTINGS_VERSION) throw new Error('Unsupported settings version');
  const legacy = input.version === undefined || input.version === 0;
  const sceneValue = has(input, 'scene') ? input.scene : legacy && has(input, 'sceneConfig') ? input.sceneConfig : undefined;
  if (sceneValue !== undefined) {
    const scene = record(sceneValue), merged: Record<string, unknown> = { ...DEFAULT_SCENE_CONFIG };
    for (const key of Object.keys(DEFAULT_SCENE_CONFIG)) if (has(scene, key)) merged[key] = scene[key];
    for (const [key, [min, max]] of Object.entries(SCENE_RANGES)) {
      const n = merged[key];
      if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`Invalid scene setting: ${key}`);
      merged[key] = Math.max(min, Math.min(max, n));
    }
    result.scene = validateSceneConfig(merged);
  }
  if (has(input, 'outputView')) result.outputView = validateOutputViewRequest(input.outputView);
  if (has(input, 'editorPose') && input.editorPose !== null) result.editorPose = validateCameraPose(input.editorPose);
  if (has(input, 'editor')) {
    const editor = record(input.editor), known: Record<string, unknown> = {};
    for (const key of ['visibleViews', 'inspectorSection']) if (has(editor, key)) known[key] = editor[key];
    if (Object.keys(known).length) result.editor = validateEditorPreferences(known, result.editor);
  }
  if (has(input, 'windowBounds') && input.windowBounds !== null) result.windowBounds = bounds(input.windowBounds);
  if (has(input, 'hudSource')) {
    if (input.hudSource !== 'live' && input.hudSource !== 'demo') throw new Error('Invalid HUD source');
    result.hudSource = input.hudSource;
  }
  if (has(input, 'outputStopped')) {
    if (typeof input.outputStopped !== 'boolean') throw new Error('Invalid output preference');
    result.outputStopped = input.outputStopped;
  }
  return result;
}
export function parseSettings(text: string): AppSettings {
  if (new TextEncoder().encode(text).byteLength > MAX_SETTINGS_BYTES) throw new Error('Settings file is too large');
  return validateSettings(JSON.parse(text, (key, value) => {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new Error('Unsafe settings key');
    return value;
  }));
}
