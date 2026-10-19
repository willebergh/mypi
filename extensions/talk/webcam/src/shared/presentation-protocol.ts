/** Explicit camera presentation only. No paths, URLs, image bytes, history or auth on the HUD wire. */
export const PRESENTATION_VERSION = 1;
export const PRESENTATION_MAX_TEXT_CHARS = 1200;
export const PRESENTATION_MAX_TEXT_BYTES = 2400;
export const PRESENTATION_MAX_TITLE_BYTES = 96;
export const PRESENTATION_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const PRESENTATION_MAX_EDGE = 4096;
export const PRESENTATION_MAX_PIXELS = 8 * 1024 * 1024;
export const PRESENTATION_PREPARED_MAX_EDGE = 1600;
export const PRESENTATION_PREPARED_MAX_BYTES = 2 * 1024 * 1024;
export const PRESENTATION_CC_SAFE_PX = 120;
export const PRESENTATION_ID = /^[a-zA-Z0-9_-]{1,128}$/;
export const PRESENTATION_ASSET_ID = /^[a-f0-9]{32}$/;
export interface PresentationImage {
  assetId: string;
  mime: 'image/png' | 'image/jpeg';
  bytes: number;
  width: number;
  height: number;
}
interface PresentationContent {
  scopeId: string;
  /** New opaque revision even for text-only replacements. */
  id: string;
  title?: string;
  text?: string;
  image?: PresentationImage;
}
/** Legacy strict-call DTO; its run gate is unchanged. */
export interface CallPresentation extends PresentationContent { version: 1; runId: string }
/** V2 display scope belongs to the actual opted-in publisher, not a voice run. */
export interface WebcamPresentation extends PresentationContent { version: 2 }
export type Presentation = CallPresentation | WebcamPresentation;
export interface DisplayAuthority {
  /** Private session identity; never forwarded to renderers or tool results. */
  sessionKey: string;
  /** Opaque generation rotated on publisher/session/branch/disconnect edges. */
  scopeId: string;
}
/** Main -> allowed preload -> renderer only, NEVER in periodic HUD snapshots. */
export interface PreparedPresentation {
  presentation: Presentation;
  image?: { assetId: string; dataUrl: string; width: number; height: number };
}
const forbidden = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
const bytes = (s: string) => new TextEncoder().encode(s).length;
export function presentationRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null)
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(field => Object.hasOwn(field, 'value'));
}
/** Reject rather than silently truncate. Plain canvas text; no HTML/Markdown interpreter. */
export function presentationText(value: unknown, title = false): string {
  if (typeof value !== 'string') throw new Error(`${title ? 'title' : 'text'} must be a string`);
  const limit = title ? PRESENTATION_MAX_TITLE_BYTES : PRESENTATION_MAX_TEXT_BYTES;
  if (value.length > (title ? limit : PRESENTATION_MAX_TEXT_CHARS) || bytes(value) > limit)
    throw new Error(`${title ? 'title' : 'text'} is too long (maximum ${title ? limit : PRESENTATION_MAX_TEXT_CHARS} characters / ${limit} UTF-8 bytes)`);
  if (forbidden.test(value) || /[\ud800-\udfff]/u.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/gu, '')))
    throw new Error('Presentation text contains unsupported control or Unicode characters');
  if (title && /[\n\t]/u.test(value)) throw new Error('title must be one line');
  const normalized = value.replace(/\t/gu, '  ').trim();
  if (normalized.length > (title ? limit : PRESENTATION_MAX_TEXT_CHARS) || bytes(normalized) > limit)
    throw new Error('Presentation text is too long after expanding tabs');
  if (/<\/?(?:think|thinking|analysis|reasoning)(?:\s|>)/iu.test(normalized)
    || /(?:\bBearer\s+\S+|\b(?:sk|sess)-[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|password|authorization)\s*[:=]\s*\S+)/iu.test(normalized))
    throw new Error('Presentation must not contain hidden reasoning, credentials or auth');
  if (!title && (normalized.split('\n').length > 16 || normalized.split(/\n\s*\n/u).length > 8))
    throw new Error('text must contain at most 16 lines and 8 paragraphs');
  return normalized;
}
export function presentationDimensions(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    && width <= PRESENTATION_MAX_EDGE && height <= PRESENTATION_MAX_EDGE && width * height <= PRESENTATION_MAX_PIXELS;
}
export function parsePresentationImage(value: unknown): PresentationImage | undefined {
  if (!presentationRecord(value) || typeof value.assetId !== 'string' || !PRESENTATION_ASSET_ID.test(value.assetId)
    || !['image/png', 'image/jpeg'].includes(value.mime as string)
    || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 24 || (value.bytes as number) > PRESENTATION_MAX_IMAGE_BYTES
    || !presentationDimensions(value.width as number, value.height as number)) return undefined;
  return { assetId: value.assetId, mime: value.mime as PresentationImage['mime'], bytes: value.bytes as number,
    width: value.width as number, height: value.height as number };
}
function parsePresentationContent(value: Record<string, unknown>): PresentationContent | undefined {
  try {
    if (typeof value.scopeId !== 'string' || !PRESENTATION_ID.test(value.scopeId)
      || typeof value.id !== 'string' || !PRESENTATION_ID.test(value.id)) return undefined;
    const title = value.title === undefined ? undefined : presentationText(value.title, true);
    const text = value.text === undefined ? undefined : presentationText(value.text);
    const image = value.image === undefined ? undefined : parsePresentationImage(value.image);
    if ((value.image !== undefined && !image) || (!text && !image)) return undefined;
    return { scopeId: value.scopeId, id: value.id,
      ...(title ? { title } : {}), ...(text ? { text } : {}), ...(image ? { image } : {}) };
  } catch { return undefined; }
}
/** Consumer supplies current verified call's visual run, never infers authority from this DTO. */
export function parseCallPresentation(value: unknown, runId: string): CallPresentation | undefined {
  try {
    if (!presentationRecord(value) || value.version !== PRESENTATION_VERSION || value.runId !== runId
      || !PRESENTATION_ID.test(runId)) return undefined;
    const content = parsePresentationContent(value);
    return content ? { version: 1, runId, ...content } : undefined;
  } catch { return undefined; }
}
/** Validate v2 only against the live publisher's separately supplied display scope.
 * Legacy v1 still requires the connected-call gate at every consumer. */
export function parsePresentation(value: unknown, authority: { displayScopeId?: string; callRunId?: string }): Presentation | undefined {
  try {
    if (!presentationRecord(value)) return undefined;
    if (value.version === 1) return authority.callRunId ? parseCallPresentation(value, authority.callRunId) : undefined;
    if (value.version !== 2 || typeof authority.displayScopeId !== 'string'
      || !PRESENTATION_ID.test(authority.displayScopeId) || value.scopeId !== authority.displayScopeId
      || Object.keys(value).some(key => !['version', 'scopeId', 'id', 'title', 'text', 'image'].includes(key))) return undefined;
    const content = parsePresentationContent(value);
    return content ? { version: 2, ...content } : undefined;
  } catch { return undefined; }
}
export function presentationRevision(value: Presentation): string {
  return JSON.stringify([value.version, value.scopeId, value.version === 1 ? value.runId : null, value.id]);
}
/** Syntactic guard only: caller MUST source this from trusted Electron preparation, not model input. */
export function preparedPresentationImage(value: unknown): PreparedPresentation['image'] {
  if (!presentationRecord(value) || typeof value.assetId !== 'string' || !PRESENTATION_ASSET_ID.test(value.assetId)
    || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
    || (value.width as number) < 1 || (value.height as number) < 1
    || (value.width as number) > PRESENTATION_PREPARED_MAX_EDGE || (value.height as number) > PRESENTATION_PREPARED_MAX_EDGE
    || typeof value.dataUrl !== 'string' || value.dataUrl.length > Math.ceil(PRESENTATION_PREPARED_MAX_BYTES / 3) * 4 + 64
    || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/u.test(value.dataUrl)) return undefined;
  return { assetId: value.assetId, dataUrl: value.dataUrl, width: value.width as number, height: value.height as number };
}
