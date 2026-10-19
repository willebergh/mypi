export const DESKTOP_SLOTS = ['left', 'upperRight', 'lowerRight', 'laptop'] as const;
export type DesktopSlot = typeof DESKTOP_SLOTS[number];
export type DesktopMapping = Record<DesktopSlot, string | null>;
export const emptyDesktopMapping = (): DesktopMapping => ({ left: null, upperRight: null, lowerRight: null, laptop: null });
export interface DesktopState {
  enabled: boolean;
  revision: number;
  mapping: DesktopMapping;
  permission: string;
  displays: { id: string; label: string }[];
  status: { editor: string; output: string };
}
export function validateDesktopMapping(value: unknown): DesktopMapping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid desktop mapping');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 4 || Object.keys(input).some(key => !DESKTOP_SLOTS.includes(key as DesktopSlot))) throw new Error('Invalid desktop slots');
  for (const slot of DESKTOP_SLOTS) if (input[slot] !== null && (typeof input[slot] !== 'string' || !/^-?\d{1,20}$/.test(input[slot] as string))) throw new Error('Invalid display ID');
  return { ...input } as DesktopMapping;
}
export function desktopDisplayIds(mapping: DesktopMapping): string[] {
  return [...new Set(DESKTOP_SLOTS.map(slot => mapping[slot]).filter((id): id is string => id !== null))];
}
export interface DesktopAPI {
  getDesktopState(): Promise<DesktopState>;
  onDesktopState(callback: (state: DesktopState) => void): () => void;
  refreshDesktopDisplays(): Promise<DesktopState>;
  setDesktopScreens(enabled: boolean, mapping: DesktopMapping): Promise<DesktopState>;
  prepareDesktopCapture(displayId: string, revision: number): Promise<string>;
  releaseDesktopCapture(token: string): Promise<void>;
  desktopCaptureStatus(status: 'starting' | 'live' | 'unavailable' | 'off', revision: number): Promise<void>;
}
