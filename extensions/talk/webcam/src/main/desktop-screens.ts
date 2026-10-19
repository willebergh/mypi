import { desktopCapturer, screen, systemPreferences, type BrowserWindow, type Session, type WebContents, type WebFrameMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { desktopDisplayIds, emptyDesktopMapping, validateDesktopMapping, type DesktopState } from '../shared/desktop-screens';

/** No constructor side effects: metadata enumeration and capture happen only on explicit UI actions. */
export class DesktopScreens {
  private state: DesktopState = { enabled: false, revision: 0, mapping: emptyDesktopMapping(), permission: 'unknown', displays: [], status: { editor: 'off', output: 'off' } };
  private leases = new Map<string, { wc: WebContents; frame: WebFrameMain; displayId: string; revision: number; pending: boolean; expires: number }>();
  constructor(private windows: () => { editor?: BrowserWindow; output?: BrowserWindow | null }, private publish: (state: DesktopState) => void, private allowed = true) {}
  role(wc: WebContents) {
    const wins = this.windows();
    return wins.editor && !wins.editor.isDestroyed() && wc === wins.editor.webContents ? 'editor'
      : wins.output && !wins.output.isDestroyed() && wc === wins.output.webContents ? 'output' : null;
  }
  read() { return structuredClone(this.state); }
  private permission() { return process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'unknown'; }
  private emit() { this.publish(this.read()); return this.read(); }
  refresh() {
    this.state.permission = this.permission();
    // Display metadata only. No thumbnails, icons, window enumeration or OS prompt.
    this.state.displays = screen.getAllDisplays().map(d => ({ id: String(d.id), label: `${d.label || 'Display'} (${d.size.width}×${d.size.height}, id ${d.id})` }));
    return this.emit();
  }
  set(enabled: unknown, mapping: unknown, desk: boolean) {
    if (typeof enabled !== 'boolean') throw new Error('Invalid desktop toggle');
    const validated = validateDesktopMapping(mapping);
    if (enabled && (!this.allowed || !desk)) throw new Error('Live desktop screens require Desk scene');
    if (enabled && desktopDisplayIds(validated).some(id => !this.state.displays.some(d => d.id === id))) throw new Error('Display unavailable; refresh and select explicitly');
    this.leases.clear();
    this.state = { ...this.state, enabled, mapping: validated, revision: this.state.revision + 1, permission: this.permission(), status: { editor: 'off', output: 'off' } };
    return this.emit();
  }
  off() {
    this.leases.clear();
    if (this.state.enabled) { this.state = { ...this.state, enabled: false, revision: this.state.revision + 1, status: { editor: 'off', output: 'off' } }; this.emit(); }
  }
  forget(wc: WebContents) { for (const [token, lease] of this.leases) if (lease.wc === wc) this.leases.delete(token); }
  prepare(wc: WebContents, frame: WebFrameMain, displayId: unknown, revision: unknown) {
    if (!this.role(wc) || frame !== wc.mainFrame || !this.allowed || !this.state.enabled || revision !== this.state.revision
      || typeof displayId !== 'string' || !desktopDisplayIds(this.state.mapping).includes(displayId)) throw new Error('Desktop capture not authorized');
    for (const [token, lease] of this.leases) {
      if (lease.pending && lease.expires < Date.now()) this.leases.delete(token);
      else if (lease.wc === wc && (lease.pending || lease.displayId === displayId)) throw new Error('Desktop capture already pending/active');
    }
    if ([...this.leases.values()].filter(l => l.wc === wc).length >= 4) throw new Error('Desktop capture limit');
    const token = randomUUID();
    this.leases.set(token, { wc, frame, displayId, revision: this.state.revision, pending: true, expires: Date.now() + 10000 });
    return token;
  }
  release(wc: WebContents, token: unknown) { if (typeof token === 'string' && this.leases.get(token)?.wc === wc) this.leases.delete(token); }
  report(wc: WebContents, status: unknown, revision: unknown) {
    const role = this.role(wc);
    if (!role || revision !== this.state.revision || !['off', 'starting', 'live', 'unavailable'].includes(status as string)) return;
    this.state.status[role] = status as string; this.emit();
  }
  install(session: Session) {
    // Do not grant media/camera/microphone or permissions to other windows/subframes.
    const pending = (wc: WebContents | null, frame?: WebFrameMain | null) => !!wc && !!this.role(wc) && this.state.enabled
      && [...this.leases.values()].some(l => l.wc === wc && l.frame === wc.mainFrame && (!frame || frame === l.frame) && l.pending && l.expires >= Date.now());
    session.setPermissionCheckHandler((wc, permission, _origin, details) => permission === 'display-capture' && pending(wc) && details.isMainFrame === true);
    session.setPermissionRequestHandler((wc, permission, callback, details) => callback(permission === 'display-capture' && details.isMainFrame === true && pending(wc)));
    session.setDisplayMediaRequestHandler((request, callback) => {
      const entry = [...this.leases.entries()].find(([, l]) => l.frame === request.frame && l.pending && l.expires >= Date.now());
      if (!entry || request.audioRequested || !request.videoRequested) { callback({}); return; }
      const [token, lease] = entry;
      // Retain the pending flag until enumeration finishes for permission checks, but reject replay.
      lease.expires = 0;
      void (async () => {
        try {
          if (!this.state.enabled || !this.role(lease.wc) || lease.revision !== this.state.revision || lease.frame !== lease.wc.mainFrame) { callback({}); return; }
          if (process.platform === 'darwin' && ['denied', 'restricted'].includes(this.permission())) { callback({}); return; }
          const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
          const selected = sources.filter(s => s.id.startsWith('screen:') && s.display_id === lease.displayId);
          if (this.leases.get(token) !== lease || !this.state.enabled || lease.revision !== this.state.revision || !this.role(lease.wc)
            || lease.wc.isDestroyed() || lease.frame !== lease.wc.mainFrame || selected.length !== 1) { callback({}); return; }
          lease.pending = false;
          callback({ video: selected[0] }); // Deliberately no audio or loopback.
        } catch { this.leases.delete(token); callback({}); }
      })();
    }, { useSystemPicker: false });
  }
}
