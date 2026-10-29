# Voice Coding Companion

A desktop app for talking to coding agents. Say what you want done, keep working while the agent works, add instructions as you think of them, and get a spoken summary backed by the full written record: code, command output, test results and every approval.

- **Agents:** Claude Code (working). Codex is planned, but its adapter is not built yet (see [Status](#status)).
- **Speech:** on your computer by default. Cloud speech is optional and clearly labelled.
- **Safety:** the agent's own permission prompts are kept. Nothing is approved for you, and approvals need a click or a key press unless you opt in to voice approvals.

## Contents

- [Status](#status)
- [Install](#install)
- [Using it](#using-it)
- [Privacy, network use and costs](#privacy-network-use-and-costs)
- [Settings](#settings)
- [Troubleshooting](#troubleshooting)
- [Development and tests](#development-and-tests)
- [Known limitations](#known-limitations)

## Status

Everything marked ✅ was tested on Windows 11 (i5-7300U, 8 GB RAM, no GPU) with Claude Code 2.1.312. Nothing has been tested on macOS or Linux yet.

| Capability | State | How it was checked |
|---|---|---|
| Spoken task → transcript → agent starts | ✅ | E2E test feeding recorded speech in as the microphone |
| Natural mid-sentence pause doesn't submit early | ✅ | E2E with a 1.8 s pause, plus unit tests for "and…", "um…" and the review window |
| Self-corrections ("…no wait, check the signup page") | ✅ | E2E with recorded speech |
| Follow-up while the agent works ("also check…") is added to the running task | ✅ | Live Claude Code test: reported as *queued*, then *accepted* when Claude confirms it; the task is not restarted |
| Explicit "stop" cancels; the result is confirmed by the agent | ✅ | Live Claude Code test and demo E2E |
| Approvals shown in the app; denials respected and reported | ✅ | Live and E2E |
| Completed, partial and failed are told apart from evidence | ✅ | Unit and live tests |
| Spoken summary is short; the full written output is kept | ✅ | Unit and E2E |
| Detail follow-ups ("explain the changes") answered without rerunning | ✅ | Live Claude Code test |
| Agent switch keeps the transcript; transcript survives a crash or restart | ✅ | E2E and unit tests |
| Mic denied or missing, speech-engine crash, agent crash | ✅ | E2E and unit fault injection |
| Packaged Windows build runs (speech and demo flow) | ✅ | E2E against the packaged `.exe` |
| Barge-in (talk over the app to interrupt it) | ⚠️ Partly | Playback stop is unit-tested. Not tested with a real mic and speakers; see limitations |
| Natural on-device voice (Kokoro) | ⚠️ Works, slow | About 3.7× slower than real time on the test CPU, so the Windows voice is the default there |
| Codex adapter | ❌ Not built | Codex isn't installed or signed in on the development machine. The app reports this honestly |
| OpenAI cloud speech (optional) | ❓ Untested | Code is in place; no key was available to test it |
| macOS and Linux | ❓ Untested | Built to be portable; installers are configured but not tried |

## Install

You need **Node.js 20 or newer** and, to do real work, **Claude Code** signed in (`npm install -g @anthropic-ai/claude-code`, then run `claude` once). Without Claude Code you can still explore everything with the built-in **demo agent**.

**Windows (PowerShell)**

```powershell
git clone https://github.com/Hashurah/voice-coding.git
cd voice-coding
powershell -ExecutionPolicy Bypass -File install.ps1
npm start
```

**macOS / Linux**

```sh
git clone https://github.com/Hashurah/voice-coding.git
cd voice-coding
sh install.sh
npm start
```

The installer checks Node, installs dependencies, builds the app, asks before downloading the speech-recognition model (~65 MB), then runs `npm run doctor`, which lists anything missing and how to fix it.

On first launch, a setup wizard walks you through:

1. What the app does with your audio.
2. An environment check.
3. Optional model downloads.
4. A microphone test and a voice comparison (it measures whether the natural voice is fast enough on your computer).
5. Choosing an agent and a project folder.

Re-open it any time from **Settings → Run setup again**.

**Installers.** `npm run dist` builds a Windows NSIS installer, a macOS DMG or a Linux AppImage on the matching platform. Only the Windows build has been tried. If packaging on Windows fails with `EBUSY … .exe`, antivirus is scanning the new executable. Wait a moment and run it again, or add the `release/` folder to its exclusions.

## Using it

1. Pick an agent at the top (start with **Demo agent** if you like) and **Choose folder…** for the project the agent may work in.
2. **Hold the mic button or the Space bar** and speak, then let go. Or turn on **Continuous listening** (Ctrl+M) and just talk; pause naturally, and the app waits longer when you trail off ("and…", "um…").
3. Your words appear, then stay editable for a moment before they are sent. Press **Esc** to discard or **Enter** to send immediately.
4. While the agent works, keep talking:

| Say | What happens |
|---|---|
| "Also…", "While you're at it…", "Add this…" | Added to the running task. Shown as *queued* until the agent confirms it, then *accepted*. |
| "Actually…", "By the way…", "For context…" | Passed on as a clarification without restarting. |
| "Do the reset flow first", "Focus on…" | Priority change for the running task. |
| "After that…", "As a separate task…" | Queued as its own task. |
| "Stop", "Cancel", "Pause" | Cancels the task. You hear whether it actually stopped. |
| "What's the status?" | Answered from the task's state, without interrupting the agent. |
| Anything ambiguous | You're asked: add to the current task, run it separately, or cancel and do this instead. |

5. Approval requests appear as cards. Press **A** to approve or **D** to deny (or click).
6. When the task ends you hear a short summary, and a report card lists what was asked, what changed, which checks ran and passed or failed, and anything left over. Buttons offer "Explain the changes", "Show me the code you changed" and similar follow-ups.

**Keyboard:** Space (hold) talk · Ctrl+M continuous listening · Esc stop speaking or discard · Enter send now · A / D approve or deny · 1–3 answer a question · Ctrl+. cancel the running task · / focus the text box. Everything works without a microphone.

## Privacy, network use and costs

| What | Where it goes | Cost |
|---|---|---|
| Your voice (default) | Stays on your computer. Recognised by Moonshine or Whisper in a local process | Free |
| Your voice (if you pick OpenAI recognition) | Uploaded to OpenAI. The header badge turns amber and says so | Billed to your OpenAI key |
| Spoken replies (default) | Windows/macOS system voice, or Kokoro on your computer | Free |
| Spoken replies (if you pick OpenAI voices) | Reply text is sent to OpenAI | Billed to your OpenAI key |
| Your instructions and project files the agent reads | Sent to the agent's provider (Anthropic for Claude Code), exactly as if you typed in its terminal | Your Claude plan or API usage |
| Model downloads | One-time, from huggingface.co, only when you ask | Free |

- **Keys.** The optional OpenAI key is encrypted with your OS keystore (Windows DPAPI, macOS Keychain, Linux libsecret) and never returned to the UI. Agent logins stay with each agent's own CLI. The app never sees them.
- **Logs** (`%APPDATA%\voice-coding-companion\logs\app.log`) contain no audio. Key-like strings are redacted.
- **Data folder.** Conversations are saved as JSON Lines in `%APPDATA%\voice-coding-companion\conversations\`.

## Settings

- **Speech recognition:** on this computer (Moonshine base by default; Whisper base or tiny as alternatives) or OpenAI.
- **Voice:** system voices, Kokoro (natural, local) or OpenAI. You can also set speed, volume and style.
- **Turn-taking:**
  - Silence before a turn ends: 1600 ms by default.
  - Extra wait after an unfinished phrase: 1600 ms.
  - Review time before sending: 1500 ms.
- **Safety:** voice approvals are **off** by default.
- **Environment overrides:**
  - `VCC_CLAUDE_MODEL` pins a Claude model; otherwise Claude Code's own default applies.
  - `VCC_MODELS_DIR` uses another models folder.

## Troubleshooting

Start with `npm run doctor`.

- **"Microphone access was refused".** On Windows, open Settings → Privacy & security → Microphone and allow desktop apps. Typing always works.
- **"No on-device speech model is installed".** Run `npm run models`, or Settings → Run setup again.
- **Claude Code shows "needs attention".** Run `claude` in a terminal and sign in, then press Recheck in Settings.
- **The app talks over itself, or hears itself, on laptop speakers.** Use headphones or push-to-talk; see the barge-in limitation below.
- **Slow replies from the natural voice.** Choose the system voice in Settings. The setup wizard measures this for you.

## Development and tests

```sh
npm run typecheck   # TypeScript
npm test            # 113 unit tests: routing, turn-taking, evidence, adapters (with a scripted SDK), speech queue
npm run test:e2e    # Electron end-to-end: demo agent, keyboard, fake-microphone voice tests, fault injection
npm run test:live   # Real Claude Code in a throwaway project (uses your account; defaults to Haiku)
npm run test:e2e:live  # Real Claude Code through the full app
npm run bench       # Speech-recognition speed on your machine
```

The voice E2E tests feed WAV files from `tests/fixtures/audio/` in as the microphone through Chromium's fake capture device, so they exercise the real voice detection, recogniser and turn-taking code. They are skipped when no speech model is installed.

Architecture, agent integration details and design decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Known limitations

- **Codex is not supported yet.** The adapter interface and status reporting are in place; the `codex app-server` integration needs a machine with Codex signed in to build and test against.
- **Barge-in on speakers.** Interrupting the app by talking is wired up: playback stops as soon as voice detection confirms speech. But the Windows system voice plays outside the app's audio path, so echo cancellation can't remove it, and on laptop speakers the app may hear itself. Headphones or push-to-talk avoid this. Not yet tested with real speakers.
- **Trailing-word cues depend on the recogniser.** During a pause, "…bug and" was transcribed as "bug end." in testing, which defeats the "sounds unfinished" check. The review window still caught the continuation, but very long pauses may submit early. Raise the silence setting if that happens.
- **Follow-ups arrive between steps, not mid-command.** Claude Code takes a follow-up at its next step boundary. If a single long command is running, the follow-up waits for it. The status shows *queued* until Claude confirms it.
- **`/btw`** is a side-question feature of interactive Claude Code and isn't available in the headless mode this app uses. Status questions are answered by the app from the task's state instead.
- **Natural voice speed.** Kokoro is about 3.7× slower than real time on a 2017 dual-core laptop CPU, so it's only practical on faster machines.

## License

MIT
