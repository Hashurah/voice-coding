# Architecture

This describes what was built and why, including what changed from the original proposal after measuring on the target machine.

## Target environment (measured 2026-10-29)

| Item | Value | Consequence |
|---|---|---|
| OS | Windows 11 Pro 23H2 | Windows is the tested platform |
| CPU / RAM / GPU | i5-7300U (2 cores / 4 threads), 8 GB, Intel HD 620 | No GPU inference; speech models must be small and run natively |
| Runtimes | Node 24, Python 3.14; no Rust, .NET SDK or ffmpeg | Electron + TypeScript; no Python in the app |
| Claude Code | 2.1.312, signed in | Integrated via the Agent SDK |
| Codex | not installed, no account | Adapter deferred |
| Audio | Conexant internal mic and speakers | Real capture device; tests use Chromium's fake capture with WAV files |

## Processes

```
┌──────────────── Renderer (sandboxed, contextIsolation, strict CSP) ────────────────┐
│ UI · keyboard · SpeechOut queue (system voice / Kokoro playback / OpenAI)          │
│ Mic → Silero VAD (WASM, AudioWorklet) → TurnAssembler (pauses, review window)      │
└─────────────────────────────▲──────── typed IPC via preload ────────────────────────┘
                              │
┌─────────────────────────────┴──────── Main process ─────────────────────────────────┐
│ TaskManager · IntentRouter · Acknowledger · evidence → CompletionReport             │
│ TranscriptStore (JSONL) · SettingsStore · CredentialStore (safeStorage) · Logger    │
│ Adapters: ClaudeAdapter (Agent SDK) · CodexAdapter (status only) · DemoAdapter      │
│ SpeechService ──► utility process "Speech": Moonshine/Whisper STT, Kokoro TTS       │
│                   (ONNX Runtime native; restarted automatically if it crashes)      │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

The UI and downloaded models are served from a custom `app://ui/` scheme with cross-origin isolation. Models live under `app://ui/models/` (same origin), because custom schemes cannot make cross-origin requests.

## Speech

**Recognition.** The plan was Whisper in a browser worker. Measured on the target machine:

| Engine | Load | 6.3–6.8 s utterance | Notes |
|---|---|---|---|
| Whisper base, WASM (browser worker) | 15.6 s | 11.2 s | Unusable |
| Whisper base, native ONNX | 2.4 s | 5.1 s | Whisper always encodes a 30 s window |
| **Moonshine base, native ONNX** | 4.2 s | **1.0 s** (0.1 s for "Stop") | Same accuracy on all fixtures. **Default** |

So recognition runs in an Electron **utility process** on native ONNX Runtime, with Moonshine as the default. A crash there can't take down the UI or the agent. An in-flight request is retried once on a fresh process, and three crashes within a minute pause on-device speech with a clear message.

**Turn-taking** (`src/core/turnAssembler.ts`, `turnDetector.ts`):

- Silero VAD cuts speech into segments; each segment is transcribed as soon as it ends.
- Silence is counted from when speech stopped, not from when transcription finished, so a slow CPU doesn't lengthen pauses.
- The budget grows after trailing hesitations ("and", "um", "no wait", a trailing comma).
- Segments are numbered, so transcriptions that finish out of order can't reorder the sentence.
- A finished turn sits in a short **review window** (Esc discards, Enter sends). Speaking during it continues the same turn. This is both the safety confirmation for spoken commands and a second chance for long pauses.
- Low-confidence output (silence, `[BLANK_AUDIO]`, short "Thank you." hallucinations, repetition loops) is rejected with "I couldn't make that out" rather than sent.

**Speaking.**

- `SpeechShaper` never reads out code blocks, diffs, stack traces, tables or long paths. It caps spoken replies at a few sentences; the written transcript is never altered.
- Conversational answers are spoken sentence by sentence as they stream in. Work tasks get one evidence-based summary at the end.
- `SpeechOut` plays one thing at a time, drops stale acknowledgements when an alert arrives, prepares the next sentence while the current one plays (Kokoro and OpenAI), and stops instantly on barge-in.
- Kokoro measured about 3.7× slower than real time natively on the target CPU, so the system voice is the default and the setup wizard measures it per machine.

## Agents

All adapters implement `AgentAdapter` (`src/shared/types.ts`) and declare their capabilities. They are deliberately not assumed to behave alike.

### Claude Code: `src/adapters/claudeAdapter.ts`

- **Interface:** `@anthropic-ai/claude-agent-sdk` `query()` in streaming-input mode, which drives the Claude Code CLI over its stream-json protocol. No terminal scraping.
- **Permissions:**
  - `permissionMode: 'default'` with the user's own settings files (`settingSources: user, project, local`).
  - Every prompt goes through `canUseTool` to an approval card. Nothing is bypassed.
  - `AskUserQuestion` is declined with a request to ask in plain text, so the question reaches the user through the transcript and speech.
- **Follow-ups during a task:**
  - Pushed into the input stream as user messages with `priority: 'next'` and the follow-up's uuid. Claude Code folds them into the running turn at the next step boundary.
  - The adapter reports **queued** on send and **accepted** only when Claude Code stamps a reply or result with that uuid (`user_message_uuid` / `user_message_uuids`).
  - If a turn ends before a follow-up is taken in, the adapter waits for the extra turn instead of declaring the task done.
  - Verified live.
- **`/btw`:** not offered by headless Claude Code (`scripts/inspect-claude-commands.mjs` lists the 66 commands it does offer). It's an interactive side-question feature, so status questions are answered locally from task state.
- **Cancel:** `Query.interrupt()`. The task becomes *cancelled* only when the terminal result arrives. A watchdog reports if that confirmation never comes.
- **Windows specifics:** Claude Code may run commands with a **PowerShell** tool as well as Bash; both are treated as shell commands.
- **Outcome:**
  - Claude is asked to end with `Outcome: complete | partial: … | blocked: …`.
  - The report uses that line plus recorded evidence. It never infers success or failure from free-form prose: an earlier keyword heuristic misread "I did not run any docs tools" as a failure and was removed.

### Codex: `src/adapters/codexAdapter.ts`

- **Status:** detects the CLI and reports clearly that the adapter is not finished. It refuses tasks rather than pretending to work.
- **Planned integration:** `codex app-server` (JSON-RPC over stdio), with turn start, streamed items, `exec` / `applyPatch` approval requests and turn interruption.
- **Follow-ups:** steering a running turn must be verified against the installed version. Until it is, Codex declares `midTaskInput: 'none'`, and the TaskManager then holds follow-ups and sends them as the next turn, saying so.

### Demo: `src/adapters/demoAdapter.ts`

A scripted agent used for demo mode and the end-to-end tests. It has the same contract: approvals, step-boundary follow-ups and confirmed cancellation. It makes no changes and uses no network.

## Task model

States: `queued → running ⇄ awaiting_input / updating → completed | partial | failed | cancelled`.

- **IntentRouter** uses deterministic rules: add, clarify, prioritise, separate, stop, status or detail.
- "Stop" counts only as a bare command or a "stop the task" phrase. "Stop using var…" leads to a question instead.
- Anything unmarked while a task runs leads to a question with three choices: add, run separately, or cancel and replace.
- The **Acknowledger** words replies from the actual receipt state ("passed that on" vs "picked it up") and rate-limits unprompted remarks.

**Completion report** (`src/core/evidence.ts`), built from structured events:

- Files changed.
- Commands with exit codes.
- Test runs, with counts parsed from vitest, jest, node --test, pytest, mocha, go and cargo output.
- Reruns of the same test (`npm test | tail -40` vs `cd x && npm test`) are matched, and the latest run counts.
- Denied commands are recorded as **not run**, never as failures.
- Approvals.
- Follow-up statuses.

The outcome is *partial* when tests still fail, a follow-up was never confirmed, the user denied an action, or the agent's own outcome line says partial or blocked.

## Persistence and recovery

- **Transcript:** append-only JSONL, one line per event. Torn lines are skipped on load. Tasks that were live when the app stopped are marked "interrupted" with a visible note.
- **Shutdown:** interrupts the running agent, stops the speech process and closes the transcript, with a 5-second cap.
- **Renderer crash:** reloads the window.
- **Second launch:** focuses the existing window.

## Security

- **Renderer:** sandbox, context isolation, no Node, strict CSP, a fixed preload API, navigation and new windows blocked. Microphone permission is granted only to `app://ui` and only for audio.
- **Credentials:** the only key the app stores (optional OpenAI) is encrypted with `safeStorage`. Cloud calls are made by the main process, so the key never reaches the page.
- **Voice approvals:** off by default. Spoken "approve" is refused with an explanation unless the user enables it.
- **Model loading:** remote downloads are disabled in the speech process; models load only from the local models folder.
- **Test hooks:** fault injection and the fake microphone exist only when `VCC_TEST=1`.
