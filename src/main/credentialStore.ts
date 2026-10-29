import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeStorage } from 'electron';

/**
 * Optional cloud-speech API keys, encrypted with the OS keystore
 * (DPAPI on Windows, Keychain on macOS, libsecret on Linux).
 * Agent credentials are never handled here: each CLI keeps its own login.
 */
export class CredentialStore {
  private file: string;

  constructor(dir: string) {
    this.file = path.join(dir, 'credentials.bin.json');
  }

  available(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  private readAll(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  set(name: string, value: string | null): void {
    if (!this.available()) throw new Error('Secure storage is not available on this system, so the key was not saved.');
    const all = this.readAll();
    if (value) all[name] = safeStorage.encryptString(value).toString('base64');
    else delete all[name];
    fs.writeFileSync(this.file, JSON.stringify(all), { mode: 0o600 });
  }

  get(name: string): string | null {
    const enc = this.readAll()[name];
    if (!enc || !this.available()) return null;
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return null;
    }
  }

  has(name: string): boolean {
    return name in this.readAll();
  }
}
