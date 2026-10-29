// Append-only JSONL transcript. Every entry is written as it happens, so a crash
// loses at most a partial line, which is skipped on load.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TaskInfo, TranscriptEntry } from '../shared/types';
import { TERMINAL_STATES } from '../shared/types';

export interface LoadedConversation {
  id: string;
  entries: TranscriptEntry[];
  tasks: TaskInfo[];
  /** Tasks that were still live when the app last stopped. */
  interrupted: TaskInfo[];
  corruptLines: number;
}

export class TranscriptStore {
  private fd: number | null = null;
  readonly file: string;

  constructor(private dir: string, readonly id: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${id}.jsonl`);
  }

  static latestId(dir: string): string | null {
    if (!fs.existsSync(dir)) return null;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return files[0]?.f.replace(/\.jsonl$/, '') ?? null;
  }

  append(entry: TranscriptEntry): void {
    if (this.fd === null) this.fd = fs.openSync(this.file, 'a');
    fs.writeSync(this.fd, `${JSON.stringify(entry)}\n`);
  }

  load(): LoadedConversation {
    const entries: TranscriptEntry[] = [];
    const tasks = new Map<string, TaskInfo>();
    let corruptLines = 0;
    if (fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as TranscriptEntry;
          if (e.type === 'task') tasks.set(e.task.id, e.task);
          else {
            const i = entries.findIndex((x) => x.id === e.id);
            if (i >= 0) entries[i] = e;
            else entries.push(e);
          }
        } catch {
          corruptLines++;
        }
      }
    }
    const all = [...tasks.values()];
    const interrupted = all.filter((t) => !TERMINAL_STATES.includes(t.state));
    return { id: this.id, entries, tasks: all, interrupted, corruptLines };
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}
