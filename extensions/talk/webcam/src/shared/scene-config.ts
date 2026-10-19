/** Stable coded environments, not editable scene documents. */
export const SCENE_OPTIONS = [
  { id: 'workshop', name: 'Workshop' },
  { id: 'desk', name: 'Desk setup' },
] as const;
export type SceneId = typeof SCENE_OPTIONS[number]['id'];
export function isSceneId(value: unknown): value is SceneId {
  return SCENE_OPTIONS.some(scene => scene.id === value);
}

/** Stable foreground choices, independent of the room. */
export const CHARACTER_OPTIONS = [
  { id: 'robot', name: 'Robot' },
  { id: 'hoodie', name: 'Hoodie & face' },
] as const;
export type CharacterId = typeof CHARACTER_OPTIONS[number]['id'];
export function isCharacterId(value: unknown): value is CharacterId {
  return CHARACTER_OPTIONS.some(character => character.id === value);
}

export type SceneAspectRatio = '16:9' | '9:16';
export function outputSize(aspect: SceneAspectRatio) {
  return aspect === '9:16' ? { width: 720, height: 1280 } : { width: 1280, height: 720 };
}

export const HUD_PANEL_KEYS = ['hudSession', 'hudSubagents', 'hudTodos', 'hudWeekly'] as const;
export const HUD_INSET_KEYS = ['hudInsetTop', 'hudInsetRight', 'hudInsetBottom', 'hudInsetLeft'] as const;
export const HUD_PORTRAIT_INSET_KEYS = ['hudPortraitInsetTop', 'hudPortraitInsetRight', 'hudPortraitInsetBottom', 'hudPortraitInsetLeft'] as const;
const ALL_HUD_INSET_KEYS = [...HUD_INSET_KEYS, ...HUD_PORTRAIT_INSET_KEYS];

export interface SceneConfig {
  sceneId: SceneId;
  characterId: CharacterId;
  aspectRatio: SceneAspectRatio;
  /** 'minimal' is accepted only for legacy configs; renders/canonicalizes as dashboard. */
  hudMode: 'dashboard' | 'minimal' | 'off';
  hudOpacity: number;
  hudSession: boolean;
  hudSubagents: boolean;
  hudTodos: boolean;
  hudWeekly: boolean;
  /** Independent landscape/portrait safe-area whitespace, percent of output. */
  hudInsetTop: number;
  hudInsetRight: number;
  hudInsetBottom: number;
  hudInsetLeft: number;
  hudPortraitInsetTop: number;
  hudPortraitInsetRight: number;
  hudPortraitInsetBottom: number;
  hudPortraitInsetLeft: number;
  eyeGlowIntensity: number;
  eyeGlowColor: string;
  eyeSquint: number;
  casingTint: string;
  casingWear: number;
  hoodieColor: string;
  idleIntensity: number;
  roomIntensity: number;
  warmCoolBalance: number;
}

export const DEFAULT_SCENE_CONFIG: Readonly<SceneConfig> = Object.freeze({
  sceneId: 'workshop',
  characterId: 'robot',
  aspectRatio: '16:9',
  hudMode: 'dashboard',
  hudOpacity: 0.82,
  hudSession: true,
  hudSubagents: true,
  hudTodos: true,
  hudWeekly: true,
  hudInsetTop: 0,
  hudInsetRight: 0,
  hudInsetBottom: 0,
  hudInsetLeft: 0,
  hudPortraitInsetTop: 0,
  hudPortraitInsetRight: 0,
  hudPortraitInsetBottom: 0,
  hudPortraitInsetLeft: 0,
  eyeGlowIntensity: 1.25,
  eyeGlowColor: '#ffc16b',
  eyeSquint: 0.55,
  casingTint: '#8c887b',
  casingWear: 0.7,
  hoodieColor: '#14181c',
  idleIntensity: 0.65,
  roomIntensity: 1,
  warmCoolBalance: 0.58,
});

export const SCENE_RANGES = {
  hudInsetTop: [0, 15], hudInsetRight: [0, 15], hudInsetBottom: [0, 15], hudInsetLeft: [0, 15],
  hudPortraitInsetTop: [0, 15], hudPortraitInsetRight: [0, 15], hudPortraitInsetBottom: [0, 15], hudPortraitInsetLeft: [0, 15],
  eyeGlowIntensity: [0, 3], eyeSquint: [0, 1], casingWear: [0, 1],
  idleIntensity: [0, 1.5], roomIntensity: [0, 2], warmCoolBalance: [0, 1], hudOpacity: [0, 1],
} as const;

/** Only known enums, bounded scalars, boolean flags and opaque RGB colors cross IPC. */
export function validateSceneConfig(value: unknown): SceneConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid scene configuration');
  const input = value as Record<string, unknown>;
  const result = { ...DEFAULT_SCENE_CONFIG };
  // Legacy snapshots predate coded scene selection. Explicit invalid IDs still fail.
  if (input.sceneId !== undefined && !isSceneId(input.sceneId)) throw new Error('Invalid scene id');
  result.sceneId = input.sceneId === undefined ? 'workshop' : input.sceneId as SceneId;
  if (input.characterId !== undefined && !isCharacterId(input.characterId)) throw new Error('Invalid character id');
  result.characterId = input.characterId === undefined ? 'robot' : input.characterId as CharacterId;
  if (input.aspectRatio !== '16:9' && input.aspectRatio !== '9:16') throw new Error('Invalid scene aspect ratio');
  result.aspectRatio = input.aspectRatio;
  if (!['dashboard', 'minimal', 'off'].includes(input.hudMode as string)) throw new Error('Invalid HUD mode');
  result.hudMode = input.hudMode === 'off' ? 'off' : 'dashboard';
  if (Object.keys(input).some(key => !Object.hasOwn(DEFAULT_SCENE_CONFIG, key))) throw new Error('Unknown scene setting');
  for (const key of HUD_PANEL_KEYS) {
    // Older snapshots have no panel flags: migrate them to the demo defaults.
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`Invalid scene setting: ${key}`);
    result[key] = input[key] === undefined ? DEFAULT_SCENE_CONFIG[key] : input[key] as boolean;
  }
  for (const [key, range] of Object.entries(SCENE_RANGES)) {
    const item = input[key] === undefined && ALL_HUD_INSET_KEYS.some(inset => inset === key)
      ? DEFAULT_SCENE_CONFIG[key as typeof ALL_HUD_INSET_KEYS[number]] : input[key];
    if (typeof item !== 'number' || !Number.isFinite(item) || item < range[0] || item > range[1]) {
      throw new Error(`Invalid scene setting: ${key}`);
    }
    (result as unknown as Record<string, unknown>)[key] = item;
  }
  for (const key of ['eyeGlowColor', 'casingTint', 'hoodieColor'] as const) {
    if (typeof input[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(input[key])) throw new Error(`Invalid scene color: ${key}`);
    result[key] = input[key];
  }
  return result;
}

export interface SceneState {
  config: SceneConfig;
  revision: number;
  outputRevision: number | null;
}
