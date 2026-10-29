// End-of-turn detection. Silence alone doesn't end a turn: a pause after
// "and…", "um…" or "no wait…" means the speaker is still thinking.

export interface TurnConfig {
  endOfTurnMs: number;
  hesitationExtraMs: number;
}

const TRAILING_HESITATION =
  /\b(?:um+|uh+|er+|erm|hmm+|so|and|but|or|then|because|like|with|to|the|a|an|of|for|in|on|that|which|if|when|also|maybe|i mean|you know|no wait|wait|actually|sorry|let me think|let me see)[\s,.…-]*$/i;
const OPEN_ENDED = /[,:\-–…]\s*$/;

export function looksUnfinished(partial: string): boolean {
  const t = partial.trim();
  if (!t) return true;
  return TRAILING_HESITATION.test(t) || OPEN_ENDED.test(t);
}

/** How long to wait after speech stops before treating the turn as over. */
export function silenceBudgetMs(partial: string, cfg: TurnConfig): number {
  return looksUnfinished(partial) ? cfg.endOfTurnMs + cfg.hesitationExtraMs : cfg.endOfTurnMs;
}

const FILLERS = /(?:^|\s)(?:um+|uh+|er+|erm|hmm+)(?=[\s,.!?]|$)[,]?/gi;
const SELF_CORRECTION = /\b(?:no wait|sorry|i mean|actually no|scratch that|let me rephrase)[,.!]?\s+/i;

/**
 * Tidies a final transcript: drops filler sounds and repeated words, and keeps
 * only the corrected version after an explicit self-correction phrase when the
 * correction is a full replacement ("check login, no wait, check signup").
 */
export function cleanTranscript(text: string): string {
  let t = text.replace(FILLERS, ' ').replace(/\s{2,}/g, ' ').trim();
  t = t.replace(/\b(\w+)(?:\s+\1\b)+/gi, '$1');
  const m = t.match(SELF_CORRECTION);
  if (m && m.index !== undefined) {
    const before = t.slice(0, m.index).replace(/[,.\s]+$/, '');
    const after = t.slice(m.index + m[0].length);
    const firstVerb = (s: string) => s.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '');
    // Same leading verb → the speaker restated the instruction; keep the restatement.
    if (before && after && firstVerb(lastClause(before)) === firstVerb(after)) {
      const head = before.slice(0, before.length - lastClause(before).length).trim();
      t = `${head ? `${head} ` : ''}${after}`;
    }
  }
  t = t.replace(/^[,\s]+/, '').replace(/\s+([,.!?])/g, '$1').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

function lastClause(s: string): string {
  const parts = s.split(/(?<=[,.;])\s+|\s+(?=\band\b)/);
  return parts[parts.length - 1].replace(/^and\s+/i, '');
}
