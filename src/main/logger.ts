import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;

/** Plain-text log with one rotation. Never logs credentials or audio. */
export class Logger {
  readonly file: string;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'app.log');
  }

  write(level: 'info' | 'warn' | 'error', msg: string): void {
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_BYTES) fs.renameSync(this.file, `${this.file}.1`);
      fs.appendFileSync(this.file, `${new Date().toISOString()} ${level.toUpperCase()} ${redact(msg)}\n`);
    } catch {
      /* logging must never take the app down */
    }
    if (level === 'error') console.error(msg);
  }
}

export function redact(s: string): string {
  return s.replace(/\b(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1…').replace(/(api[_-]?key["'=:\s]+)[^\s"']+/gi, '$1[redacted]');
}
