// Assembles speech segments (from the VAD + recogniser) into one user turn.
// Continuous mode: a turn ends after a silence budget that grows when the
// words so far sound unfinished. Push-to-talk: a turn ends on release.
// Either way, the finished text is shown for a short review window before it
// is sent, and speaking again during that window resumes the same turn.

import { cleanTranscript, silenceBudgetMs } from './turnDetector';

export type TurnState = 'idle' | 'listening' | 'hearing' | 'transcribing' | 'reviewing';

export interface TurnSettings {
  endOfTurnMs: number;
  hesitationExtraMs: number;
  reviewWindowMs: number;
}

export interface TurnCallbacks {
  onState(s: TurnState): void;
  onPartial(text: string): void;
  onReview(text: string, msLeft: number): void;
  onFinal(text: string): void;
  onDiscard(reason: string): void;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(h: unknown): void;
  now(): number;
}

/** Silence the VAD has already waited before it reports the end of a segment. */
export const VAD_REDEMPTION_MS = 600;

export class TurnAssembler {
  mode: 'ptt' | 'continuous' = 'ptt';
  /** Transcribed text by segment number, so slow results can't reorder speech. */
  private segments: (string | undefined)[] = [];
  private nextSeq = 0;
  private lastSpeechEndAt = 0;
  private unclear = 0;
  private pending = 0;
  private speaking = false;
  private released = false;
  private endTimer: unknown = null;
  private reviewTimer: unknown = null;
  private reviewText = '';
  private reviewLeft = 0;
  private active = false;

  constructor(
    private cfg: () => TurnSettings,
    private cb: TurnCallbacks,
    private timers: Timers = { set: (f, ms) => setTimeout(f, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), now: () => Date.now() },
  ) {}

  get text(): string {
    return this.segments.filter(Boolean).join(' ').trim();
  }

  /** Start of a push-to-talk press, or of continuous listening. */
  begin(mode: 'ptt' | 'continuous'): void {
    this.mode = mode;
    this.released = false;
    if (!this.active) {
      this.active = true;
      if (!this.reviewTimer) this.reset();
    }
    if (!this.reviewTimer) this.cb.onState('listening');
  }

  speechStart(): void {
    this.speaking = true;
    this.clearEnd();
    if (this.reviewTimer) {
      // Talking during review means the turn isn't over: carry on with it.
      this.timers.clear(this.reviewTimer);
      this.reviewTimer = null;
      this.segments = [this.reviewText];
      this.nextSeq = 1;
    }
    this.cb.onState('hearing');
  }

  /** Returns the segment number to pass back with its transcription. */
  speechEnd(): number {
    this.speaking = false;
    this.pending++;
    this.lastSpeechEndAt = this.timers.now();
    this.cb.onState('transcribing');
    return this.nextSeq++;
  }

  /** A short blip the VAD decided wasn't speech. */
  misfire(): void {
    this.speaking = false;
    this.afterSegment();
  }

  /** Result for one segment; null when it couldn't be transcribed reliably. */
  segmentText(seq: number, text: string | null): void {
    this.pending = Math.max(0, this.pending - 1);
    if (text && text.trim()) {
      this.segments[seq] = text.trim();
      this.cb.onPartial(this.text);
    } else this.unclear++;
    this.afterSegment();
  }

  private afterSegment(): void {
    if (this.speaking) return;
    if (this.mode === 'ptt') {
      if (this.released && this.pending === 0) this.finish();
      else if (!this.released && this.pending === 0) this.cb.onState('listening');
      return;
    }
    if (this.pending > 0) return;
    if (!this.text) {
      if (this.unclear) this.finish();
      else this.cb.onState('listening');
      return;
    }
    this.cb.onState('listening');
    // Silence is counted from when speech stopped, not from when transcription finished.
    const silentFor = VAD_REDEMPTION_MS + (this.timers.now() - this.lastSpeechEndAt);
    const budget = Math.max(0, silenceBudgetMs(this.text, this.cfg()) - silentFor);
    this.clearEnd();
    this.endTimer = this.timers.set(() => {
      this.endTimer = null;
      if (!this.speaking && this.pending === 0) this.finish();
    }, budget);
  }

  /** Push-to-talk released. */
  release(): void {
    this.released = true;
    if (this.speaking) return; // the recogniser will still deliver the last segment
    if (this.pending === 0) this.finish();
  }

  /** Continuous listening switched off. */
  stopListening(): void {
    this.active = false;
    this.clearEnd();
    if (this.pending === 0 && !this.speaking && this.text) this.finish();
    else if (!this.reviewTimer && !this.pending) this.cb.onState('idle');
  }

  private finish(): void {
    this.clearEnd();
    const raw = this.text;
    const unclear = this.unclear;
    this.reset();
    const text = cleanTranscript(raw);
    if (!text) {
      this.cb.onDiscard(unclear ? "I couldn't make that out. Please try again, or type it." : "I didn't hear anything.");
      this.cb.onState(this.mode === 'continuous' && this.active ? 'listening' : 'idle');
      return;
    }
    const windowMs = this.cfg().reviewWindowMs;
    if (windowMs <= 0) return this.deliver(text);
    this.reviewText = text;
    this.reviewLeft = windowMs;
    this.cb.onState('reviewing');
    this.cb.onReview(text, this.reviewLeft);
    const tick = () => {
      this.reviewLeft -= 100;
      if (this.reviewLeft <= 0) {
        this.reviewTimer = null;
        this.deliver(this.reviewText);
        return;
      }
      this.cb.onReview(this.reviewText, this.reviewLeft);
      this.reviewTimer = this.timers.set(tick, 100);
    };
    this.reviewTimer = this.timers.set(tick, 100);
  }

  private deliver(text: string): void {
    this.reviewText = '';
    this.cb.onFinal(text);
    this.cb.onState(this.mode === 'continuous' && this.active ? 'listening' : 'idle');
  }

  sendNow(): void {
    if (!this.reviewTimer) return;
    this.timers.clear(this.reviewTimer);
    this.reviewTimer = null;
    this.deliver(this.reviewText);
  }

  discard(reason = 'Discarded.'): boolean {
    const had = !!this.reviewTimer || !!this.text || this.speaking || this.pending > 0;
    if (this.reviewTimer) this.timers.clear(this.reviewTimer);
    this.reviewTimer = null;
    this.reviewText = '';
    this.clearEnd();
    this.reset();
    this.pending = 0;
    this.speaking = false;
    if (had && reason) this.cb.onDiscard(reason);
    this.cb.onState(this.mode === 'continuous' && this.active ? 'listening' : 'idle');
    return had;
  }

  private clearEnd(): void {
    if (this.endTimer) this.timers.clear(this.endTimer);
    this.endTimer = null;
  }

  private reset(): void {
    this.segments = [];
    this.nextSeq = 0;
    this.unclear = 0;
  }
}

/** Common Whisper outputs on silence or noise, which must not be treated as speech. */
const HALLUCINATIONS = /^(?:thank you\.?|thanks for watching!?|you|bye\.?|\.+|okay\.?|so\.?|uh\.?|um\.?|hmm\.?)$/i;

export function reliableText(text: string, audioSeconds: number, rms: number): string | null {
  let t = text.replace(/\[[^\]]*]|\([^)]*\)|\*[^*]*\*|♪+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || !/[a-z0-9]/i.test(t)) return null;
  if (rms < 0.004) return null; // essentially silence
  if (audioSeconds < 1.2 && HALLUCINATIONS.test(t)) return null;
  // Repetition loops ("the the the the …") are a decoding failure, not speech.
  if (/(\b\w+\b)(?:\W+\1\b){4,}/i.test(t)) return null;
  t = t.replace(/^[-–\s]+/, '');
  return t;
}
