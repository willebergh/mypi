import path from 'node:path';
import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { defaultSettings, MAX_SETTINGS_BYTES, parseSettings, validateSettings, type AppSettings, type SettingsStatus } from '../shared/settings.ts';

class UnsafeSettingsPath extends Error {}
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const fingerprint = (s: Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
function owned(s: Stats) {
  if (process.getuid && s.uid !== process.getuid()) throw new UnsafeSettingsPath('Settings path is not owned by this user');
}
function regular(s: Stats) {
  owned(s);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new UnsafeSettingsPath('Settings must be a regular file without symbolic or hard links');
}

/** One main-owned file. No renderer paths, private-config discovery or localStorage.
 * Updates are snapshots; one drain loop always writes old -> new, never new -> old.
 */
export class SettingsStore {
  readonly filePath: string;
  private readonly directory: string;
  private readonly publish: (status: SettingsStatus) => void;
  private readonly enabled: boolean;
  private value = defaultSettings();
  private loaded = false;
  private revision = 0;
  private savedRevision = 0;
  private expectedFile: string | null = null;
  private warning: string | null = null;
  private readOnly = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> | null = null;

  constructor(directory: string, publish: (status: SettingsStatus) => void, enabled = true) {
    this.directory = directory;
    this.filePath = path.join(directory, 'settings.json');
    this.publish = publish;
    this.enabled = enabled;
  }
  get(): AppSettings { return structuredClone(this.value); }
  status(): SettingsStatus { return { filePath: this.filePath, warning: this.warning, readOnly: this.readOnly }; }
  private report(message: string | null) {
    this.warning = message;
    try { this.publish(this.status()); } catch { /* Closing editor must not interrupt recovery or quit. */ }
  }
  private async directoryReady() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const s = await lstat(this.directory);
    owned(s);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new UnsafeSettingsPath('Settings directory must not be a symlink');
    await chmod(this.directory, 0o700);
  }
  private async currentFile(): Promise<Stats | null> {
    try { const s = await lstat(this.filePath); regular(s); return s; }
    catch (error) { if (missing(error)) return null; throw error; }
  }
  async load(): Promise<AppSettings> {
    if (this.loaded) throw new Error('Settings already loaded');
    try {
      if (this.enabled) {
        await this.directoryReady();
        const before = await this.currentFile();
        if (before) {
          if (before.size > MAX_SETTINGS_BYTES) throw new Error('Settings file is too large');
          const file = await open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const s = await file.stat(); regular(s);
            if (fingerprint(s) !== fingerprint(before)) throw new UnsafeSettingsPath('Settings changed while loading');
            const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
            let length = 0;
            while (length < buffer.length) {
              const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
              if (!bytesRead) break;
              length += bytesRead;
            }
            if (length > MAX_SETTINGS_BYTES) throw new Error('Settings file is too large');
            this.value = parseSettings(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
            if (fingerprint(await file.stat()) !== fingerprint(s)) throw new UnsafeSettingsPath('Settings changed while loading');
            await file.chmod(0o600);
            this.expectedFile = fingerprint(await file.stat());
          } finally { await file.close(); }
        }
      }
    } catch (error) {
      // Unknown preferences must not accidentally revive explicitly stopped output.
      this.value = { ...defaultSettings(), outputStopped: true };
      this.readOnly = true;
      this.report(`Preferences could not be loaded (${this.reason(error)}). Defaults are in use; saving is disabled and the original is untouched. Quit, repair or rename ${this.filePath}, then reopen. Do not delete a symlink target.`);
    }
    this.loaded = true;
    return this.get();
  }
  update(patch: Partial<Omit<AppSettings, 'version'>>): void {
    if (!this.loaded) throw new Error('Settings have not loaded');
    const next = validateSettings({ ...this.value, ...patch });
    if (JSON.stringify(next) === JSON.stringify(this.value)) return;
    this.value = next;
    if (!this.enabled || this.readOnly) return;
    this.revision++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 250);
  }
  private reason(error: unknown): string {
    // No file contents or unrelated private paths in warnings/logs.
    if (error instanceof SyntaxError) return 'Invalid settings JSON';
    const code = (error as NodeJS.ErrnoException)?.code;
    return code || (error instanceof Error ? error.message : 'I/O error');
  }
  private async writeSnapshot(value: AppSettings) {
    await this.directoryReady();
    const before = await this.currentFile();
    if ((before ? fingerprint(before) : null) !== this.expectedFile) throw new UnsafeSettingsPath('Settings changed outside this app; original preserved');
    const temporary = path.join(this.directory, `.settings-${randomUUID()}.tmp`);
    let created = false;
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); await file.sync(); }
      finally { await file.close(); }
      const current = await this.currentFile();
      if ((current ? fingerprint(current) : null) !== this.expectedFile) throw new UnsafeSettingsPath('Settings changed outside this app; original preserved');
      await rename(temporary, this.filePath);
      created = false;
      const saved = await this.currentFile();
      this.expectedFile = saved ? fingerprint(saved) : null;
      // Sync the directory entry where supported; Windows does not allow directory handles.
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          try { await directory.sync(); }
          catch (error) { if (!['EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
        } finally { await directory.close(); }
      }
    } finally {
      if (created) await unlink(temporary).catch(() => {}); // Only our exclusive random temp file.
    }
  }
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.writing) return this.writing;
    if (!this.enabled || this.readOnly || this.savedRevision === this.revision) return;
    this.writing = (async () => {
      while (this.savedRevision !== this.revision && !this.readOnly) {
        const revision = this.revision, value = this.get();
        try {
          await this.writeSnapshot(value);
          this.savedRevision = revision;
          if (this.warning) this.report(null);
        } catch (error) {
          if (error instanceof UnsafeSettingsPath) this.readOnly = true;
          this.report(`Preferences were not saved (${this.reason(error)}). ${this.readOnly
            ? 'Saving is disabled to preserve the existing file. Quit, repair or rename the settings file, then reopen.'
            : 'Check free space and owner permissions; another edit or normal Quit retries.'} File: ${this.filePath}`);
          return;
        }
      }
    })().finally(() => { this.writing = null; });
    return this.writing;
  }
}
