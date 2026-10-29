import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Settings } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';

/** Non-secret preferences. Credentials live in CredentialStore, never here. */
export class SettingsStore {
  private file: string;
  private value: Settings;

  constructor(dir: string) {
    this.file = path.join(dir, 'settings.json');
    this.value = { ...DEFAULT_SETTINGS };
    try {
      this.value = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      /* first run or unreadable: defaults */
    }
  }

  get(): Settings {
    return this.value;
  }

  update(patch: Partial<Settings>): Settings {
    const allowed = Object.fromEntries(Object.entries(patch).filter(([k]) => k in DEFAULT_SETTINGS));
    this.value = { ...this.value, ...allowed };
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2));
    fs.renameSync(tmp, this.file);
    return this.value;
  }
}
