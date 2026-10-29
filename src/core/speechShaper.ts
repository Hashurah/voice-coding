// Turns written agent output into something worth saying aloud.
// The written transcript is never modified; this only decides what is spoken.

const FENCE = /```[\s\S]*?(?:```|$)/g;
const STACK_LINE = /^\s*(?:at\s+\S+.*\(.*:\d+:\d+\)|at\s+\S+:\d+:\d+|File ".*", line \d+|Traceback \(most recent call last\)|\w+(?:Error|Exception):.*\n\s+at\b)/;
const TABLE_LINE = /^\s*\|.*\|\s*$/;
const DIFF_LINE = /^[+-]{1,3}\s|^@@ /;

/** Replace things that read badly aloud with short spoken equivalents. */
export function toSpeakable(markdown: string): string {
  let t = markdown.replace(FENCE, ' ');

  // "- item" is a list unless the text looks like a diff.
  const isDiff = /^(?:@@ |\+\+\+ |--- |\+)/m.test(t);
  const lines = t.split(/\r?\n/).filter((line) => {
    if (STACK_LINE.test(line)) return false;
    if (TABLE_LINE.test(line)) return false;
    if (isDiff && DIFF_LINE.test(line)) return false;
    if (/^\s*[-=*_]{3,}\s*$/.test(line)) return false;
    return true;
  });
  t = lines
    .map((l) => l.replace(/^\s*#{1,6}\s+/, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))
    .map((l) => (l.trim() && !/[.!?:;]$/.test(l.trim()) ? `${l.trim()}.` : l.trim()))
    .join(' ');

  t = t
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+?(?=[.,;:!?]?(?:\s|$))/g, 'a link')
    // Inline code: keep short identifiers, drop long snippets.
    .replace(/`([^`]+)`/g, (_, code: string) => (code.length <= 32 && !/[;{}()=<>]/.test(code) ? speakIdentifier(code) : 'the code shown'))
    .replace(/(?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/]){2,}([\w.-]+)/g, '$1') // long paths → file name
    .replace(/\*\*|__|\*|~~/g, '')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/\.{2,}/g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return t;
}

function speakIdentifier(code: string): string {
  if (/^[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|cs|json|md|yml|yaml|toml|css|html)$/.test(code)) return code;
  return code.replace(/_/g, ' ');
}

export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?]+(?:[.!?]+(?=\s|$)|$)/g;
  for (const m of text.matchAll(re)) {
    const s = m[0].trim();
    if (s.length > 1) out.push(s);
  }
  return out;
}

export interface SpeechPlan {
  sentences: string[];
  truncated: boolean;
}

/** Concise spoken version of a full response. */
export function planSpeech(markdown: string, maxSentences = 3, maxChars = 420): SpeechPlan {
  const sentences = splitSentences(toSpeakable(markdown));
  const kept: string[] = [];
  let chars = 0;
  for (const s of sentences) {
    if (kept.length >= maxSentences || chars + s.length > maxChars) break;
    kept.push(s);
    chars += s.length;
  }
  return { sentences: kept, truncated: kept.length < sentences.length };
}

/**
 * Incremental sentence extraction from streamed text, so speech can start
 * before a response finishes. Feed deltas; complete sentences come out.
 * Text inside an open code fence is held back until the fence closes.
 */
export class SentenceStream {
  private buf = '';

  push(delta: string): string[] {
    this.buf += delta;
    const fences = (this.buf.match(/```/g) ?? []).length;
    if (fences % 2 === 1) return [];
    const lastEnd = Math.max(
      this.buf.lastIndexOf('. '),
      this.buf.lastIndexOf('! '),
      this.buf.lastIndexOf('? '),
      this.buf.lastIndexOf('.\n'),
      this.buf.lastIndexOf('\n\n'),
    );
    if (lastEnd < 0) return [];
    const ready = this.buf.slice(0, lastEnd + 1);
    this.buf = this.buf.slice(lastEnd + 1);
    return splitSentences(toSpeakable(ready));
  }

  flush(): string[] {
    const rest = this.buf;
    this.buf = '';
    return splitSentences(toSpeakable(rest));
  }
}
