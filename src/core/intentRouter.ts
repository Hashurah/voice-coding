// Decides what an utterance means relative to the work already in progress.
// Deterministic rules on purpose: misrouting "stop" or "add" has real consequences,
// so anything that doesn't match clearly becomes a question to the user.

export type Intent =
  | { kind: 'new' }
  | { kind: 'add' }
  | { kind: 'clarify' }
  | { kind: 'separate' }
  | { kind: 'stop' }
  | { kind: 'prioritise' }
  | { kind: 'status' }
  | { kind: 'detail' }
  | { kind: 'ask'; question: string; options: { label: string; value: AskChoice }[] };

export type AskChoice = 'add' | 'clarify' | 'separate' | 'stop' | 'replace';

export interface RouteContext {
  hasActiveTask: boolean;
  hasFinishedTask: boolean;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const STOP_ONLY =
  /^(?:(?:ok|okay|hey|no|wait|actually|please|just|right|um|uh|never mind|nevermind|forget it)\s+)*(?:stop|cancel|abort|halt|pause|kill)(?:\s+(?:it|that|this|now|please|the task|this task|that task|the job|everything|working|what you're doing|right now|for now))*$/;
const STOP_LEAD = /^(?:please\s+)?(?:stop|cancel|abort|pause|halt)\b/;
const STOP_NEGATED = /\b(?:don't|do not|dont|never)\s+(?:stop|cancel|abort|pause)\b/;
const STOP_OBJECT = /^(?:please\s+)?(?:stop|cancel|abort|pause)\s+(?:the|this|that|current|my)\s+(?:task|job|run|work)\b/;

const ADD =
  /\balso\b|\b(?:and also|while you're at it|while you are at it|add this|add that|on top of that|as well as that|in addition|additionally|one more thing)\b|\bas well$|\btoo$/;
const CLARIFY =
  /^(?:actually|i mean|i meant|to clarify|by the way|btw|fyi|for context|note that|just so you know|keep in mind|remember that|bear in mind|correction)\b|\b(?:the (?:file|code|bug|function|config|test) is in|it's in the|it lives in)\b/;
const PRIORITISE =
  /\b(?:prioriti[sz]e|priority|first of all|do that first|do this first|handle (?:that|this|the \w+(?: \w+)?) first|focus on|before anything else|start with|look at (?:that|this|the \w+(?: \w+)?) first)\b/;
const SEPARATE =
  /\b(?:separate(?:ly)?|new task|another task|next task|different task|after (?:that|this|you're done|you finish)|when you're (?:done|finished)|once you're (?:done|finished)|afterwards|later on|queue (?:this|that|up))\b/;
const STATUS =
  /^(?:what(?:'s| is| are)? (?:you doing|the status|happening|going on)|how(?:'s| is) it going|status|progress|where are you(?: at)?|are you (?:done|finished|still working))\b/;
const DETAIL =
  /\b(?:explain (?:the |those |these )?changes|explain (?:that|it|what you did)|more detail|show me (?:the )?(?:code|changes|diff)|why did (?:that|the|this) (?:test )?fail|what (?:would|should) you improve|what changed|what did you (?:change|do)|continue with the next task|summari[sz]e)\b/;

export function routeUtterance(raw: string, ctx: RouteContext): Intent {
  const s = norm(raw);
  if (!s) return { kind: 'ask', question: "I didn't catch anything there.", options: [] };

  if (!ctx.hasActiveTask) {
    if (STATUS.test(s)) return { kind: 'status' };
    if (ctx.hasFinishedTask && DETAIL.test(s)) return { kind: 'detail' };
    return { kind: 'new' };
  }

  // Stop is only ever taken from an unambiguous command.
  if (!STOP_NEGATED.test(s)) {
    if (STOP_ONLY.test(s) || STOP_OBJECT.test(s)) return { kind: 'stop' };
    if (STOP_LEAD.test(s)) {
      // "Stop using var in that file" is an instruction, not a cancellation.
      return {
        kind: 'ask',
        question: 'Do you want me to cancel the current task, or pass that on as an instruction?',
        options: [
          { label: 'Cancel the task', value: 'stop' },
          { label: 'Pass it on', value: 'add' },
        ],
      };
    }
  }

  if (STATUS.test(s)) return { kind: 'status' };
  if (SEPARATE.test(s)) return { kind: 'separate' };
  if (PRIORITISE.test(s)) return { kind: 'prioritise' };
  if (ADD.test(s)) return { kind: 'add' };
  if (CLARIFY.test(s)) return { kind: 'clarify' };

  return {
    kind: 'ask',
    question: 'Should I add that to the current task, or queue it as a separate task?',
    options: [
      { label: 'Add to current task', value: 'add' },
      { label: 'Separate task', value: 'separate' },
      { label: 'Cancel and do this instead', value: 'replace' },
    ],
  };
}
