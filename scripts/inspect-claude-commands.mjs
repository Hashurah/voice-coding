// Prints the slash commands and protocol capabilities headless Claude Code
// advertises at start-up, then exits before any model call is made.
import { query } from '@anthropic-ai/claude-agent-sdk';

const ac = new AbortController();
async function* input() {
  yield { type: 'user', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null };
  await new Promise(() => {});
}

setTimeout(() => {
  console.error('No init message within 60s.');
  process.exit(1);
}, 60_000);

for await (const m of query({ prompt: input(), options: { abortController: ac, cwd: process.cwd() } })) {
  if (m.type === 'system' && m.subtype === 'init') {
    const names = (m.slash_commands ?? []).map((c) => String(c.name ?? c));
    console.log(`Claude Code ${m.claude_code_version ?? '?'}: ${names.length} slash commands`);
    console.log(`/btw advertised in headless mode: ${names.some((n) => /^btw$/i.test(n))}`);
    console.log(`commands: ${names.join(', ')}`);
    console.log(`capabilities: ${(m.capabilities ?? []).join(', ') || '(none listed)'}`);
    ac.abort();
    process.exit(0);
  }
}
