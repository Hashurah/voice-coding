import type { AgentId, Api, AppSnapshot, HealthReport, PendingQuestion, Settings, TaskInfo, TranscriptEntry, UiEvent } from '../shared/types';
import { escapeHtml as esc, renderMarkdown } from './markdown';
import { SpeechOut, SystemTts, type TtsEngine } from './speechOut';
import { runWizard } from './wizard';
import type { VoiceController, VoiceState } from './voice';

declare global {
  interface Window {
    vcc: Api;
  }
}

const api = window.vcc;
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

let settings!: Settings;
let snapshot!: AppSnapshot;
const tasks = new Map<string, TaskInfo>();
const health: Partial<Record<AgentId, HealthReport>> = {};
let voice: VoiceController | null = null;
let voiceState: VoiceState = 'idle';
const systemTts = new SystemTts();
const speech = new SpeechOut(systemTts, systemTts);
/** Everything the app chose to say aloud, for diagnostics and automated tests. */
const spoken: string[] = [];
(window as unknown as { __vcc: unknown }).__vcc = { spoken, speech, voiceState: () => voiceState };

window.addEventListener('error', (e) => api.logRenderer('error', `${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => api.logRenderer('error', `unhandled: ${(e.reason as Error)?.stack ?? e.reason}`));

// ---------- rendering ----------

const log = $<HTMLDivElement>('#log');
let stickToBottom = true;
log.addEventListener('scroll', () => {
  stickToBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
});
const scroll = () => {
  if (stickToBottom) log.scrollTop = log.scrollHeight;
};

function entryEl(e: TranscriptEntry): HTMLElement | null {
  const el = document.createElement('div');
  el.dataset.id = e.id;
  switch (e.type) {
    case 'user':
      el.className = 'msg user';
      el.innerHTML = `<div class="who">You${e.via === 'voice' ? ' · voice' : ''}</div><div>${esc(e.text)}</div>`;
      break;
    case 'agent_text':
      el.className = 'msg agent md';
      el.innerHTML = `<div class="who">${esc(agentLabel(e.agentId))}</div><div class="body">${renderMarkdown(e.text)}</div>`;
      break;
    case 'assistant':
      el.className = 'msg assistant';
      el.textContent = e.text;
      break;
    case 'system':
      el.className = `msg system ${e.level}`;
      el.textContent = e.text;
      break;
    case 'tool':
    case 'command': {
      const isCmd = e.type === 'command';
      if (isCmd && log.querySelector(`[data-id="${CSS.escape(e.id.replace(/^cmd-/, ''))}"]`)) {
        // The Bash tool row already shows this command; fold the exit code into it.
        return null;
      }
      el.className = 'tool';
      const d = document.createElement('details');
      fillTool(d, e);
      el.append(d);
      break;
    }
    case 'approval':
      el.className = `approval${e.decision ? ' done' : ''}`;
      el.innerHTML = `<div class="title">Approval needed · ${esc(e.tool)}</div><div>${esc(e.description)}</div>${
        e.detail ? `<pre>${esc(e.detail)}</pre>` : ''
      }<div class="actions">${
        e.decision
          ? `<span>${e.decision === 'allow' ? '✓ Approved' : '✗ Denied'}</span>`
          : `<button class="primary" data-approve="allow">Approve (A)</button><button class="danger" data-approve="deny">Deny (D)</button>`
      }</div>`;
      el.querySelectorAll<HTMLButtonElement>('[data-approve]').forEach((b) =>
        b.addEventListener('click', () => void api.approve(e.id, b.dataset.approve as 'allow' | 'deny')),
      );
      break;
    case 'report':
      el.className = `report md ${e.report.outcome}`;
      el.innerHTML = `${renderMarkdown(e.report.markdown)}<div class="followups">${
        e.report.outcome === 'cancelled' ? '' : ['Explain the changes in more detail', 'Show me the code you changed', ...(e.report.failed.length ? ['Why did that test fail?'] : []), 'What would you improve next?']
          .map((q) => `<button data-ask="${esc(q)}">${esc(q)}</button>`)
          .join('')
      }</div>`;
      el.querySelectorAll<HTMLButtonElement>('[data-ask]').forEach((b) => b.addEventListener('click', () => void api.submit(b.dataset.ask!, 'keyboard')));
      break;
    case 'task':
      return null;
  }
  return el;
}

function fillTool(d: HTMLDetailsElement, e: Extract<TranscriptEntry, { type: 'tool' | 'command' }>): void {
  const isCmd = e.type === 'command';
  const label = isCmd ? `$ ${e.command}` : e.summary;
  const ok = isCmd ? (e.exitCode === undefined ? undefined : e.exitCode === 0) : e.ok;
  const cmd = isCmd ? null : log.querySelector<HTMLElement>(`[data-id="cmd-${CSS.escape(e.id)}"]`);
  const notRun = isCmd && e.exitCode === undefined && /^Not run/.test(e.output ?? '');
  const status = notRun
    ? '<span class="status fail">✗ not run</span>'
    : ok === undefined
      ? '<span class="status run">running…</span>'
      : ok
        ? '<span class="status ok">✓ done</span>'
        : '<span class="status fail">✗ failed</span>';
  const exit = isCmd && e.exitCode !== undefined ? ` · exit ${e.exitCode}` : '';
  d.innerHTML = `<summary><span class="badge">${esc(isCmd ? 'Bash' : e.tool)}</span><span>${esc(label)}</span>${status.replace('</span>', `${exit}</span>`)}</summary>${
    e.output ? `<pre>${esc(e.output)}</pre>` : ''
  }`;
  if (ok === false) d.open = true;
  cmd?.remove();
}

function addEntry(e: TranscriptEntry): void {
  const el = entryEl(e);
  if (!el) return;
  log.append(el);
  scroll();
}

const entries = new Map<string, TranscriptEntry>();

function updateEntry(id: string, patch: Partial<TranscriptEntry>): void {
  const prev = entries.get(id);
  const target = id;
  if (!prev) return;
  const next = { ...prev, ...patch } as TranscriptEntry;
  entries.set(target, next);
  // Bash exit codes arrive as command updates; show them on the matching tool row.
  if (id.startsWith('cmd-')) {
    const toolId = id.slice(4);
    const tool = entries.get(toolId);
    const el = log.querySelector<HTMLDetailsElement>(`[data-id="${CSS.escape(toolId)}"] details`);
    if (tool && tool.type === 'tool' && el && next.type === 'command') fillTool(el, { ...next, id: toolId });
    return;
  }
  const old = log.querySelector<HTMLElement>(`[data-id="${CSS.escape(target)}"]`);
  if (old && next.type === 'tool') {
    // A command row is already showing exit code and output; don't overwrite it.
    if (entries.has(`cmd-${target}`)) return;
    const d = old.querySelector('details');
    if (d) fillTool(d, next);
    return;
  }
  const el = entryEl(next);
  if (old && el) old.replaceWith(el);
}

function onEntry(e: TranscriptEntry): void {
  entries.set(e.id, e);
  addEntry(e);
}

function renderTasks(): void {
  const ol = $<HTMLOListElement>('#tasks');
  const list = [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
  ol.innerHTML = list.length ? '' : '<li class="hint">No tasks yet.</li>';
  for (const t of list) {
    const li = document.createElement('li');
    li.className = 'task';
    const fu = t.followUps.map((f) => `<div class="t-fu">↳ ${esc(f.text.slice(0, 80))} · <strong>${f.status}</strong></div>`).join('');
    const live = ['running', 'awaiting_input', 'updating'].includes(t.state);
    li.innerHTML = `<div class="t-title">${esc(t.title)}</div><div class="t-meta"><span class="st ${t.state}">${t.state.replace('_', ' ')}</span><span>${esc(agentLabel(t.agentId))}</span>${
      t.priority ? `<span>priority ${t.priority}</span>` : ''
    }</div>${fu}<div class="t-actions">${live || t.state === 'queued' ? `<button data-cancel>${t.state === 'queued' ? 'Remove' : 'Cancel'}</button>` : ''}${
      t.state === 'queued' ? '<button data-up>Do next</button>' : ''
    }</div>`;
    li.querySelector('[data-cancel]')?.addEventListener('click', () => void api.cancelTask(t.id));
    li.querySelector('[data-up]')?.addEventListener('click', () => {
      const max = Math.max(0, ...[...tasks.values()].map((x) => x.priority));
      void api.setPriority(t.id, max + 1);
    });
    ol.append(li);
  }
  renderAgentState();
}

function activeTask(): TaskInfo | undefined {
  return [...tasks.values()].find((t) => ['running', 'awaiting_input', 'updating'].includes(t.state));
}

function renderAgentState(): void {
  const el = $<HTMLSpanElement>('#agentState');
  const t = activeTask();
  const queued = [...tasks.values()].filter((x) => x.state === 'queued').length;
  el.className = 'pill state';
  if (!t) el.textContent = queued ? `Agent: idle · ${queued} queued` : 'Agent: idle';
  else if (t.state === 'awaiting_input') {
    el.textContent = 'Agent: waiting for your approval';
    el.classList.add('awaiting');
  } else {
    el.textContent = t.state === 'updating' ? 'Agent: taking your follow-up' : `Agent: working${queued ? ` · ${queued} queued` : ''}`;
    el.classList.add('working');
  }
}

function renderVoiceState(): void {
  const el = $<HTMLSpanElement>('#voiceState');
  const labels: Record<VoiceState, string> = {
    idle: 'Voice: idle',
    starting: 'Voice: starting microphone…',
    listening: 'Voice: listening',
    hearing: 'Voice: hearing you',
    transcribing: 'Voice: transcribing…',
    reviewing: 'Voice: about to send (Esc to discard)',
    error: 'Voice: microphone unavailable',
  };
  const s = speech.speaking ? 'Voice: speaking' : labels[voiceState];
  el.textContent = s;
  el.className = `pill state${speech.speaking ? ' speaking' : ['listening', 'hearing'].includes(voiceState) ? ' listening' : ''}`;
  const mic = $<HTMLButtonElement>('#mic');
  mic.setAttribute('aria-pressed', String(['listening', 'hearing'].includes(voiceState)));
  mic.classList.toggle('busy', voiceState === 'transcribing' || voiceState === 'starting');
  mic.classList.toggle('err', voiceState === 'error');
  $<HTMLButtonElement>('#stopSpeech').disabled = !speech.speaking;
}

function agentLabel(id: AgentId): string {
  return { demo: 'Demo agent', claude: 'Claude Code', codex: 'Codex' }[id];
}

function renderConn(): void {
  const el = $<HTMLSpanElement>('#conn');
  const h = health[settings.agentId];
  el.className = `pill ${!h ? '' : h.ok ? 'ok' : h.installed ? 'warn' : 'err'}`;
  el.querySelector('.label')!.textContent = !h ? 'Checking…' : `${agentLabel(settings.agentId)}: ${h.ok ? 'ready' : h.installed ? 'needs attention' : 'not installed'}`;
  el.title = h ? `${h.detail}${h.fix ? `\n${h.fix}` : ''}` : '';
  const list = $<HTMLDivElement>('#healthList');
  list.innerHTML = (['demo', 'claude', 'codex'] as AgentId[])
    .map((id) => {
      const r = health[id];
      return `<div class="h-row"><strong>${agentLabel(id)}</strong><span>${r ? (r.ok ? '✓' : '✗') : '…'} ${esc(r?.detail ?? 'Checking…')}</span></div>${
        r?.fix ? `<div class="h-fix">${esc(r.fix)}</div>` : ''
      }`;
    })
    .join('');
}

function renderPrivacy(): void {
  const el = $<HTMLSpanElement>('#privacy');
  const cloudStt = settings.sttEngine === 'openai';
  const cloudTts = settings.ttsEngine === 'openai';
  el.classList.toggle('cloud', cloudStt || cloudTts);
  el.textContent = cloudStt ? 'Audio: sent to OpenAI' : cloudTts ? 'Audio: on-device · speech text sent to OpenAI' : 'Audio: on-device';
  el.title = `${cloudStt ? 'Your recorded speech is uploaded to OpenAI for transcription.' : 'Speech is transcribed on this computer.'} ${
    cloudTts ? 'Replies are sent to OpenAI to be voiced.' : 'Replies are voiced on this computer.'
  } Instructions you send always go to the selected agent's provider.`;
}

function renderQuestion(q: PendingQuestion | null | undefined): void {
  const box = $<HTMLDivElement>('#question');
  box.hidden = !q;
  if (!q) return;
  box.querySelector('.q-text')!.textContent = q.question;
  const opts = box.querySelector('.q-options')!;
  opts.innerHTML = '';
  q.options.forEach((o, i) => {
    const b = document.createElement('button');
    b.textContent = `${o.label} (${i + 1})`;
    b.addEventListener('click', () => void api.answerQuestion(q.id, o.value));
    opts.append(b);
  });
}

// ---------- events from main ----------

function applySnapshot(s: AppSnapshot): void {
  snapshot = s;
  settings = s.settings;
  log.innerHTML = '';
  entries.clear();
  tasks.clear();
  for (const t of s.tasks) tasks.set(t.id, t);
  for (const e of s.transcript) onEntry(e);
  if (!s.transcript.length)
    onEntry({ type: 'system', id: 'welcome', at: Date.now(), level: 'info', text: 'Hold the mic button (or Space) and say what you want done, or type below. Everything said and done stays in this transcript.' });
  Object.assign(health, s.health);
  renderTasks();
  renderConn();
  renderPrivacy();
  renderQuestion(s.pendingQuestion);
  ($<HTMLSelectElement>('#agent')).value = settings.agentId;
  $<HTMLButtonElement>('#folder').textContent = settings.cwd ? `📁 ${settings.cwd.split(/[\\/]/).pop()}` : 'Choose folder…';
  $<HTMLButtonElement>('#folder').title = settings.cwd || 'Project folder the agent works in';
  ($<HTMLInputElement>('#speak')).checked = settings.speak;
  ($<HTMLInputElement>('#rate')).value = String(settings.rate);
  ($<HTMLInputElement>('#volume')).value = String(settings.volume);
  ($<HTMLInputElement>('#continuous')).checked = settings.listenMode === 'continuous';
  speech.enabled = settings.speak;
  speech.rate = settings.rate;
  speech.volume = settings.volume;
}

api.onEvent((e: UiEvent) => {
  switch (e.type) {
    case 'snapshot':
      applySnapshot(e.snapshot);
      break;
    case 'entry':
      onEntry(e.entry);
      break;
    case 'entry_update':
      updateEntry(e.id, e.patch);
      break;
    case 'agent_delta': {
      const prev = entries.get(e.entryId);
      if (prev && prev.type === 'agent_text') {
        prev.text += e.text;
        const body = log.querySelector(`[data-id="${CSS.escape(e.entryId)}"] .body`);
        if (body) body.innerHTML = renderMarkdown(prev.text);
        scroll();
      }
      break;
    }
    case 'task':
      tasks.set(e.task.id, e.task);
      renderTasks();
      break;
    case 'say':
      spoken.push(e.text);
      speech.say(e.text, e.priority);
      break;
    case 'question':
      renderQuestion(e.question);
      break;
    case 'health':
      health[e.agentId] = e.report;
      renderConn();
      break;
  }
});

// ---------- input ----------

const input = $<HTMLTextAreaElement>('#input');

async function send(text: string, via: 'voice' | 'keyboard'): Promise<void> {
  const t = text.trim();
  if (!t) return;
  speech.stop();
  try {
    await api.submit(t, via);
  } catch (err) {
    onEntry({ type: 'system', id: crypto.randomUUID(), at: Date.now(), level: 'error', text: `Could not send: ${(err as Error).message}` });
  }
}

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const t = input.value;
    input.value = '';
    autosize();
    void send(t, 'keyboard');
  }
});
const autosize = () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(160, input.scrollHeight)}px`;
};
input.addEventListener('input', autosize);
$('#send').addEventListener('click', () => {
  const t = input.value;
  input.value = '';
  autosize();
  void send(t, 'keyboard');
});

$<HTMLSelectElement>('#agent').addEventListener('change', async (e) => {
  const id = (e.target as HTMLSelectElement).value as AgentId;
  await api.switchAgent(id);
  settings.agentId = id;
  renderConn();
});
$('#folder').addEventListener('click', async () => {
  const dir = await api.chooseFolder();
  if (dir) {
    settings.cwd = dir;
    $<HTMLButtonElement>('#folder').textContent = `📁 ${dir.split(/[\\/]/).pop()}`;
    $<HTMLButtonElement>('#folder').title = dir;
  }
});
$('#newConv').addEventListener('click', async () => {
  try {
    await api.newConversation();
  } catch (err) {
    onEntry({ type: 'system', id: crypto.randomUUID(), at: Date.now(), level: 'warn', text: (err as Error).message.replace(/^Error invoking remote method '\w+': (?:Error: )?/, '') });
  }
});
$('#stopSpeech').addEventListener('click', () => speech.stop());
$<HTMLInputElement>('#speak').addEventListener('change', async (e) => {
  const on = (e.target as HTMLInputElement).checked;
  speech.enabled = on;
  if (!on) speech.stop();
  settings = await api.updateSettings({ speak: on });
});
for (const id of ['rate', 'volume'] as const) {
  $<HTMLInputElement>(`#${id}`).addEventListener('change', async (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    speech[id] = v;
    settings = await api.updateSettings({ [id]: v });
  });
}
$<HTMLInputElement>('#continuous').addEventListener('change', async (e) => {
  const on = (e.target as HTMLInputElement).checked;
  settings = await api.updateSettings({ listenMode: on ? 'continuous' : 'push-to-talk' });
  await setContinuous(on);
});

// ---------- voice ----------

async function ensureVoice(): Promise<VoiceController | null> {
  if (voice) return voice;
  try {
    const mod = await import('./voice');
    voice = mod.createVoice({
      api,
      settings: () => settings,
      onState: (s) => {
        voiceState = s;
        renderVoiceState();
      },
      onPartial: (text) => {
        const live = $<HTMLDivElement>('#live');
        live.className = 'live';
        live.textContent = text;
      },
      onReview: (text, msLeft) => {
        const live = $<HTMLDivElement>('#live');
        live.className = 'live final';
        live.innerHTML = `${esc(text)}${msLeft > 0 ? `<span class="countdown">sending in ${(msLeft / 1000).toFixed(1)}s · Esc to discard · Enter to send now</span>` : ''}`;
      },
      onFinal: (text) => {
        $<HTMLDivElement>('#live').textContent = '';
        void send(text, 'voice');
      },
      onDiscard: (reason) => {
        const live = $<HTMLDivElement>('#live');
        live.className = 'live';
        live.textContent = reason;
        setTimeout(() => {
          if (live.textContent === reason) live.textContent = '';
        }, 4000);
      },
      onSpeechStart: () => {
        // Barge-in: the user talking always wins over the app talking.
        if (speech.speaking) speech.stop();
      },
      onError: (msg) => {
        onEntry({ type: 'system', id: crypto.randomUUID(), at: Date.now(), level: 'error', text: msg });
        api.logRenderer('warn', msg);
      },
      onInfo: (msg) => onEntry({ type: 'system', id: crypto.randomUUID(), at: Date.now(), level: 'info', text: msg }),
      isSpeaking: () => speech.speaking,
    });
    return voice;
  } catch (err) {
    onEntry({ type: 'system', id: crypto.randomUUID(), at: Date.now(), level: 'error', text: `Voice input could not load: ${(err as Error).message}. You can keep typing.` });
    return null;
  }
}

async function setContinuous(on: boolean): Promise<void> {
  const v = await ensureVoice();
  await v?.setContinuous(on);
}

const mic = $<HTMLButtonElement>('#mic');
mic.addEventListener('pointerdown', async (e) => {
  e.preventDefault();
  if (settings.listenMode === 'continuous') return;
  (await ensureVoice())?.pttDown();
});
const release = async () => {
  if (settings.listenMode === 'continuous') return;
  voice?.pttUp();
};
mic.addEventListener('pointerup', release);
mic.addEventListener('pointerleave', () => {
  if (voiceState === 'listening' || voiceState === 'hearing') void release();
});
mic.addEventListener('click', async () => {
  if (settings.listenMode === 'continuous') {
    const on = !(voiceState === 'listening' || voiceState === 'hearing');
    await setContinuous(on);
  }
});

// ---------- keyboard ----------

let spaceHeld = false;
const typing = () => document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLSelectElement;

document.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') {
    speech.stop();
    voice?.discard();
    return;
  }
  if (e.ctrlKey && e.key === '.') {
    e.preventDefault();
    const t = activeTask();
    if (t && confirm(`Cancel "${t.title}"?`)) await api.cancelTask(t.id);
    return;
  }
  if (e.ctrlKey && (e.key === 'm' || e.key === 'M')) {
    e.preventDefault();
    const box = $<HTMLInputElement>('#continuous');
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change'));
    return;
  }
  if (e.key === 'Enter' && voiceState === 'reviewing' && !typing()) {
    e.preventDefault();
    voice?.sendNow();
    return;
  }
  if (typing()) return;
  if (e.key === '/') {
    e.preventDefault();
    input.focus();
    return;
  }
  if (e.code === 'Space' && !e.repeat && settings.listenMode !== 'continuous') {
    e.preventDefault();
    spaceHeld = true;
    (await ensureVoice())?.pttDown();
    return;
  }
  const pendingApproval = [...log.querySelectorAll<HTMLElement>('.approval:not(.done)')].pop();
  if (pendingApproval && (e.key === 'a' || e.key === 'd')) {
    e.preventDefault();
    await api.approve(pendingApproval.dataset.id!, e.key === 'a' ? 'allow' : 'deny');
    return;
  }
  const q = $<HTMLDivElement>('#question');
  if (!q.hidden && /^[1-9]$/.test(e.key)) {
    q.querySelectorAll<HTMLButtonElement>('.q-options button')[Number(e.key) - 1]?.click();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && spaceHeld) {
    spaceHeld = false;
    voice?.pttUp();
  }
});

// ---------- settings dialog ----------

const dlg = $<HTMLDialogElement>('#settings');
$('#settingsBtn').addEventListener('click', async () => {
  const f = dlg.querySelector('form')!;
  (f.querySelector(`input[name=stt][value="${settings.sttEngine}"]`) as HTMLInputElement).checked = true;
  (f.querySelector(`input[name=tts][value="${settings.ttsEngine}"]`) as HTMLInputElement).checked = true;
  for (const k of ['endOfTurnMs', 'hesitationExtraMs', 'reviewWindowMs'] as const) ($<HTMLInputElement>(`#${k}`)).value = String(settings[k]);
  ($<HTMLInputElement>('#voiceApprovals')).checked = settings.voiceApprovals;
  ($<HTMLSelectElement>('#style')).value = settings.style;
  ($<HTMLSelectElement>('#sttModel')).value = settings.sttModel;
  await fillVoices();
  await renderKeyStatus();
  dlg.showModal();
});
dlg.addEventListener('close', async () => {
  const f = dlg.querySelector('form')!;
  const sttEngine = (f.querySelector('input[name=stt]:checked') as HTMLInputElement).value as Settings['sttEngine'];
  const ttsEngine = (f.querySelector('input[name=tts]:checked') as HTMLInputElement).value as Settings['ttsEngine'];
  const creds = await api.credentialStatus();
  if ((sttEngine === 'openai' || ttsEngine === 'openai') && !creds.openai) {
    onEntry({ type: 'system', id: crypto.randomUUID(), at: Date.now(), level: 'warn', text: 'OpenAI speech needs an API key. Keeping on-device speech.' });
  }
  settings = await api.updateSettings({
    sttEngine: sttEngine === 'openai' && !creds.openai ? 'local' : sttEngine,
    ttsEngine: ttsEngine === 'openai' && !creds.openai ? settings.ttsEngine : ttsEngine,
    voice: ($<HTMLSelectElement>('#voice')).value,
    style: ($<HTMLSelectElement>('#style')).value as Settings['style'],
    sttModel: ($<HTMLSelectElement>('#sttModel')).value as Settings['sttModel'],
    endOfTurnMs: clampNum('#endOfTurnMs', 500, 5000, settings.endOfTurnMs),
    hesitationExtraMs: clampNum('#hesitationExtraMs', 0, 5000, settings.hesitationExtraMs),
    reviewWindowMs: clampNum('#reviewWindowMs', 0, 10000, settings.reviewWindowMs),
    voiceApprovals: ($<HTMLInputElement>('#voiceApprovals')).checked,
  });
  await configureTts();
  renderPrivacy();
});
f_on('#recheck', 'click', async () => {
  Object.assign(health, await api.checkHealth());
  renderConn();
});
f_on('#runSetup', 'click', async () => {
  dlg.close();
  await runWizard(api, () => settings, (s) => applySnapshot({ ...snapshot, settings: s }));
  await configureTts().catch(() => undefined);
});
f_on('#saveKey', 'click', async () => {
  const el = $<HTMLInputElement>('#openaiKey');
  const r = await api.setCredential('openai', el.value);
  el.value = '';
  $<HTMLParagraphElement>('#keyStatus').textContent = r.ok ? 'Saved in the system keystore.' : `Not saved: ${r.error}`;
});
f_on('#clearKey', 'click', async () => {
  await api.setCredential('openai', null);
  await renderKeyStatus();
});
dlg.querySelectorAll('input[name=tts]').forEach((r) => r.addEventListener('change', () => void fillVoices()));

function f_on(sel: string, ev: string, fn: () => void): void {
  $(sel).addEventListener(ev, fn);
}

function clampNum(sel: string, min: number, max: number, fallback: number): number {
  const v = Number(($<HTMLInputElement>(sel)).value);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

async function renderKeyStatus(): Promise<void> {
  const c = await api.credentialStatus();
  $<HTMLParagraphElement>('#keyStatus').textContent = !c.secureStorage
    ? 'Secure storage is not available on this system, so keys cannot be saved.'
    : c.openai
      ? 'An OpenAI key is stored in the system keystore. It is used only for the cloud options you select.'
      : 'No key stored. Only needed for the cloud options.';
}

const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];

async function fillVoices(): Promise<void> {
  const engine = ((dlg.querySelector('input[name=tts]:checked') as HTMLInputElement | null)?.value ?? settings.ttsEngine) as Settings['ttsEngine'];
  const sel = $<HTMLSelectElement>('#voice');
  let list: { id: string; label: string }[] = [];
  if (engine === 'system') list = await systemTts.voices();
  else if (engine === 'openai') list = OPENAI_VOICES.map((v) => ({ id: v, label: v }));
  else list = (await import('./kokoro')).KOKORO_VOICES;
  sel.innerHTML = list.map((v) => `<option value="${esc(v.id)}">${esc(v.label)}</option>`).join('');
  if (list.some((v) => v.id === settings.voice)) sel.value = settings.voice;
}

async function configureTts(): Promise<void> {
  let engine: TtsEngine = systemTts;
  if (settings.ttsEngine === 'kokoro') {
    const { KokoroTts } = await import('./kokoro');
    const k = KokoroTts.shared(api);
    if (await k.isInstalled()) engine = k;
    else if (settings.firstRunDone) api.logRenderer('info', 'Kokoro voice not downloaded; using the system voice.');
  } else if (settings.ttsEngine === 'openai') {
    const { OpenAiTts } = await import('./cloudTts');
    engine = new OpenAiTts(api);
  }
  speech.engine = engine;
  const voices = await engine.voices();
  speech.voice = voices.some((v) => v.id === settings.voice) ? settings.voice : (voices[0]?.id ?? '');
}

speech.onState = () => renderVoiceState();
speech.onError = (msg) => onEntry({ type: 'system', id: crypto.randomUUID(), at: Date.now(), level: 'warn', text: msg });

// ---------- start ----------

(async () => {
  applySnapshot(await api.snapshot());
  renderVoiceState();
  if (!settings.firstRunDone) await runWizard(api, () => settings, (s) => applySnapshot({ ...snapshot, settings: s }));
  await configureTts().catch((err) => api.logRenderer('warn', `TTS setup: ${err}`));
  if (settings.listenMode === 'continuous') await setContinuous(true);
})();
