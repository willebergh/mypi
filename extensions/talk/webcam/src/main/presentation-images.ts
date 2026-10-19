import { nativeImage } from 'electron';
import { readPresentationAsset } from '../shared/presentation-assets.ts';
import { PRESENTATION_PREPARED_MAX_BYTES, PRESENTATION_PREPARED_MAX_EDGE, parsePresentation, presentationDimensions,
  type Presentation, type PreparedPresentation, type PresentationImage } from '../shared/presentation-protocol.ts';

/** Main only. Exact opaque cache reference -> bounded local bytes -> decoded pixels
 * -> downscaled/re-encoded data URL. No source path, remote fetch, protocol handler,
 * server, renderer-selected filename, or multi-MB periodic snapshot payload. */
export function preparePresentationImage(socketPath: string, image: PresentationImage): NonNullable<PreparedPresentation['image']> {
  const bytes = readPresentationAsset(socketPath, image);
  const decoded = nativeImage.createFromBuffer(bytes);
  const original = decoded.getSize();
  if (decoded.isEmpty() || !presentationDimensions(original.width, original.height)
    || !((original.width === image.width && original.height === image.height)
      || (image.mime === 'image/jpeg' && original.width === image.height && original.height === image.width)))
    throw new Error('Presentation image could not be decoded safely');
  let edge = PRESENTATION_PREPARED_MAX_EDGE;
  for (let attempt = 0; attempt < 4; attempt++) {
    const scale = Math.min(1, edge / original.width, edge / original.height);
    const width = Math.max(1, Math.round(original.width * scale)), height = Math.max(1, Math.round(original.height * scale));
    const thumbnail = decoded.resize({ width, height, quality: 'good' });
    // Re-encoding discards source EXIF/text chunks. PNG preserves alpha; JPEG is opaque.
    const encoded = image.mime === 'image/png' ? thumbnail.toPNG() : thumbnail.toJPEG(85);
    if (encoded.length > 0 && encoded.length <= PRESENTATION_PREPARED_MAX_BYTES) {
      return { assetId: image.assetId, width, height, dataUrl: `data:${image.mime};base64,${encoded.toString('base64')}` };
    }
    edge = Math.floor(edge / 2);
  }
  throw new Error('Presentation thumbnail exceeded its memory bound');
}
export interface PresentationPreparationInput {
  /** Host checks fresh live publisher; v1 additionally requires a verified call.
   * Never prepare from demo, offline, stale, unowned, or bare presentation data. */
  active: boolean;
  runId?: string;
  displayScopeId?: string;
  presentation?: unknown;
}
export interface PresentationPreparationOptions {
  /** Actual current HUD-client socket, supports retargeting/custom agentDir. */
  socketPath(): string;
  /** Full replacements to allowed editor/output webContents only. null clears. */
  publish(value: PreparedPresentation | null): void;
  /** Recheck absolute live-feed freshness after a potentially slow native decode. */
  stillActive?(presentation: Presentation): boolean;
  prepare?: (socketPath: string, image: PresentationImage) => NonNullable<PreparedPresentation['image']> | Promise<NonNullable<PreparedPresentation['image']>>;
}
/** Single in-flight decode plus ONE latest pending input. Old image disappears on
 * every revision/asset/run/socket change before decode begins. Generation fences
 * reject late async completions and get() never returns previous content. */
export function createPresentationPreparer(options: PresentationPreparationOptions) {
  let current: PreparedPresentation | null = null;
  let signature = '', generation = 0, busy = false, disposed = false;
  let pending: { presentation: Presentation; socket: string; token: number } | undefined;
  function publish(value: PreparedPresentation | null) {
    current = value;
    options.publish(value ? structuredClone(value) : null);
  }
  async function drain(): Promise<void> {
    if (busy || disposed) return;
    busy = true;
    try {
      while (pending && !disposed) {
        const job = pending;
        pending = undefined;
        try {
          const image = await (options.prepare ?? preparePresentationImage)(job.socket, job.presentation.image!);
          if (!disposed && job.token === generation) {
            if (options.socketPath() === job.socket && (options.stillActive?.(job.presentation) ?? true))
              publish({ presentation: job.presentation, image });
            else { signature = ''; generation++; pending = undefined; publish(null); }
          }
        } catch {
          // Keep new text/neutral image-unavailable placeholder; never resurrect old image.
          // No raw filesystem/decoder errors cross IPC.
        }
      }
    } finally { busy = false; }
  }
  return {
    update(input: PresentationPreparationInput): void {
      if (disposed) return;
      const presentation = input.active ? parsePresentation(input.presentation, {
        callRunId: input.runId, displayScopeId: input.displayScopeId,
      }) : undefined;
      const socket = options.socketPath();
      const next = presentation ? JSON.stringify([socket, presentation]) : '';
      if (next === signature) return;
      signature = next; generation++; pending = undefined;
      if (!presentation) { publish(null); return; }
      // Clear old pixels immediately, even if a previous decode is still running.
      publish({ presentation });
      if (presentation.image) { pending = { presentation, socket, token: generation }; void drain(); }
    },
    read(): PreparedPresentation | null { return current ? structuredClone(current) : null; },
    /** Use on socket disconnect/retarget, sharing off, session/branch change, and demo mode (call loss for v1 only). */
    clear(): void { if (disposed) return; signature = ''; generation++; pending = undefined; publish(null); },
    dispose(): void { if (disposed) return; signature = ''; generation++; pending = undefined; publish(null); disposed = true; },
  };
}
