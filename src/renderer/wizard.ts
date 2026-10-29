// First-run setup: what the app does with audio, environment checks,
// optional model downloads, microphone test and agent choice.

import type { AgentId, Api, HealthReport, Settings } from '../shared/types';
import { escapeHtml as esc } from './markdown';

export async function runWizard(api: Api, getSettings: () => Settings, apply: (s: Settings) => void): Promise<void> {

  interface Step {
    html(): Promise<string> | string;
    enter?(el: HTMLElement): Promise<void> | void;
    leave?(): Promise<void> | void;
  }

  const welcomeStep: Step = {
    html: () => `<h2 id="wizardTitle">Welcome</h2>
      <p>This app lets you talk to Claude Code (and later Codex) and keeps the full written conversation: code, errors, test output and approvals.</p>
      <ul class="checklist">
        <li><strong>Speech stays on this computer by default.</strong> Recognition and voices run locally. Cloud speech is off unless you turn it on in Settings, which says when audio leaves the device.</li>
        <li><strong>Your instructions go to the agent you pick</strong> (Anthropic for Claude Code), exactly as if you had typed them in its terminal.</li>
        <li><strong>The agent's permission prompts are kept.</strong> Nothing is approved for you; approvals need a click or a key press.</li>
        <li>Nothing is installed or downloaded without your say-so on the next screens.</li>
      </ul>`,
  };

  const checksStep: Step = {
    async html() {
      const [info, health, creds] = await Promise.all([api.systemInfo(), api.checkHealth(), api.credentialStatus()]);
      const row = (ok: boolean | 'warn', text: string) => `<li class="${ok === 'warn' ? 'warn' : ok ? 'ok' : 'bad'}">${text}</li>`;
      const h = (id: AgentId, r?: HealthReport) =>
        row(r?.ok ? true : r?.installed ? 'warn' : id === 'codex' ? 'warn' : false, `<strong>${id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex' : 'Demo agent'}</strong>: ${esc(r?.detail ?? 'unknown')}${r?.fix ? `<br><span class="hint">${esc(r.fix)}</span>` : ''}`);
      return `<h2 id="wizardTitle">Checking your computer</h2>
        <ul class="checklist">
          ${row(true, `${esc(info.platform)} ${esc(info.arch)} · ${info.cpus} threads (${esc(info.cpuModel)}) · ${info.memGB} GB RAM`)}
          ${h('demo', health.demo)}
          ${h('claude', health.claude)}
          ${h('codex', health.codex)}
          ${row(creds.secureStorage ? true : 'warn', creds.secureStorage ? 'Secure key storage is available.' : 'Secure key storage is unavailable; cloud speech keys cannot be saved.')}
        </ul>`;
    },
  };

  const modelsStep: Step = {
    async html() {
      const list = await api.modelStatus();
      return `<h2 id="wizardTitle">On-device speech</h2>
        <p>These models let speech work offline. They are downloaded once from huggingface.co into this app's data folder.</p>
        <ul class="checklist" id="modelList">${list
          .map(
            (m) =>
              `<li class="${m.installed ? 'ok' : ''}"><label><input type="checkbox" data-model="${m.id}" ${m.installed ? 'checked disabled' : m.id === 'moonshine-base' ? 'checked' : ''}/> <strong>${esc(m.label)}</strong> (~${m.approxMB} MB)${m.installed ? ' installed' : ''}</label><br><span class="hint">${esc(m.purpose)}</span></li>`,
          )
          .join('')}</ul>
        <div class="progress" hidden><div></div></div><p class="hint" id="dlStatus"></p>
        <button type="button" id="download">Download selected</button>
        <p class="hint">On slower computers the natural voice can take several seconds per sentence. The next step measures it, and you can choose the Windows voice instead.</p>`;
    },
    enter(el) {
      const btn = el.querySelector('#download') as HTMLButtonElement;
      const bar = el.querySelector('.progress') as HTMLDivElement;
      const status = el.querySelector('#dlStatus') as HTMLParagraphElement;
      const off = api.onEvent((e) => {
        if (e.type !== 'model_progress') return;
        bar.hidden = false;
        (bar.firstElementChild as HTMLDivElement).style.width = `${e.total ? Math.round((e.received / e.total) * 100) : 0}%`;
        status.textContent = `${e.id}: file ${e.fileIndex + 1} of ${e.fileCount} (${e.file}) ${(e.received / 1e6).toFixed(1)} MB`;
      });
      btn.addEventListener('click', async () => {
        const ids = [...el.querySelectorAll<HTMLInputElement>('[data-model]:checked:not(:disabled)')].map((c) => c.dataset.model!);
        if (!ids.length) return;
        btn.disabled = true;
        const r = await api.downloadModels(ids);
        status.textContent = r.ok ? 'Downloaded.' : `Download failed: ${r.error}. You can retry, or use Windows voices and type instead.`;
        btn.disabled = false;
        if (r.ok) el.querySelectorAll<HTMLInputElement>('[data-model]:checked').forEach((c) => (c.disabled = true));
      });
      modelsStep.leave = () => off();
    },
  };

  const micStep: Step = {
    html() {
      return `<h2 id="wizardTitle">Microphone and voice</h2>
        <p>Test your microphone, then pick a voice. Speech is processed on this computer.</p>
        <button type="button" id="micTest">Test microphone (3 seconds)</button>
        <div class="progress" id="micLevel"><div></div></div><p class="hint" id="micStatus"></p>
        <button type="button" id="voiceTest">Compare voices</button><p class="hint" id="voiceStatus"></p>`;
    },
    enter(el) {
      const status = el.querySelector('#micStatus') as HTMLElement;
      const level = el.querySelector('#micLevel > div') as HTMLDivElement;
      el.querySelector('#micTest')!.addEventListener('click', async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const ctx = new AudioContext();
          const an = ctx.createAnalyser();
          ctx.createMediaStreamSource(stream).connect(an);
          const data = new Float32Array(an.fftSize);
          let peak = 0;
          status.textContent = 'Say something…';
          const end = Date.now() + 3000;
          await new Promise<void>((resolve) => {
            const tick = () => {
              an.getFloatTimeDomainData(data);
              const r = Math.sqrt(data.reduce((s, x) => s + x * x, 0) / data.length);
              peak = Math.max(peak, r);
              level.style.width = `${Math.min(100, r * 400)}%`;
              if (Date.now() < end) requestAnimationFrame(tick);
              else resolve();
            };
            tick();
          });
          stream.getTracks().forEach((t) => t.stop());
          void ctx.close();
          status.textContent = peak > 0.02 ? '✓ Microphone works.' : 'The microphone is very quiet or silent. Check the input device in Windows sound settings.';
        } catch (err) {
          status.textContent = `Microphone unavailable: ${(err as Error).message}. You can still type everything.`;
        }
      });
      const vs = el.querySelector('#voiceStatus') as HTMLElement;
      el.querySelector('#voiceTest')!.addEventListener('click', async () => {
        const sample = "Got it. I'll check the password-reset flow as part of this task.";
        vs.textContent = 'Playing the Windows voice…';
        await new Promise<void>((r) => {
          const u = new SpeechSynthesisUtterance(sample);
          u.onend = () => r();
          u.onerror = () => r();
          speechSynthesis.speak(u);
        });
        const { KokoroTts } = await import('./kokoro');
        const k = KokoroTts.shared(api);
        if (!(await k.isInstalled())) {
          vs.textContent = 'Natural voice not downloaded; the Windows voice will be used.';
          await api.updateSettings({ ttsEngine: 'system' });
          return;
        }
        vs.textContent = 'Preparing the natural voice (the first time takes a while)…';
        const t = performance.now();
        try {
          await k.speak(sample, { rate: 1, volume: 0.9, voice: 'af_heart' }, new AbortController().signal);
          const secs = ((performance.now() - t) / 1000).toFixed(1);
          const slow = k.rtf > 0.9;
          vs.textContent = slow
            ? `The natural voice took ${secs}s, about ${k.rtf.toFixed(1)}× slower than real time on this computer, so the Windows voice is selected. You can change this in Settings.`
            : `The natural voice works at ${k.rtf.toFixed(2)}× real time. Selected.`;
          await api.updateSettings({ ttsEngine: slow ? 'system' : 'kokoro', voice: slow ? '' : 'af_heart' });
        } catch (err) {
          vs.textContent = `The natural voice failed (${(err as Error).message}); using the Windows voice.`;
          await api.updateSettings({ ttsEngine: 'system' });
        }
      });
    },
  };

  const agentStep: Step = {
    html() {
      const s = getSettings();
      return `<h2 id="wizardTitle">Agent and project</h2>
        <fieldset><legend>Start with</legend>
          <label><input type="radio" name="wagent" value="demo" ${s.agentId === 'demo' ? 'checked' : ''}/> Demo agent: explore the app with no setup; nothing on disk changes.</label>
          <label><input type="radio" name="wagent" value="claude" ${s.agentId === 'claude' ? 'checked' : ''}/> Claude Code: real work in a folder you choose, under your normal Claude Code permissions.</label>
        </fieldset>
        <button type="button" id="wfolder">Choose project folder…</button> <span class="hint" id="wfolderName">${esc(s.cwd || 'No folder chosen yet')}</span>`;
    },
    enter(el) {
      el.querySelector('#wfolder')!.addEventListener('click', async () => {
        const d = await api.chooseFolder();
        if (d) (el.querySelector('#wfolderName') as HTMLElement).textContent = d;
      });
      agentStep.leave = async () => {
        const v = (el.querySelector('input[name=wagent]:checked') as HTMLInputElement | null)?.value as AgentId | undefined;
        if (v) await api.switchAgent(v);
      };
    },
  };


  const steps: Step[] = [welcomeStep, checksStep, modelsStep, micStep, agentStep];
  const dlg = document.querySelector('#wizard') as HTMLDialogElement;
  let i = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  async function show(): Promise<void> {
    dlg.innerHTML = `<div class="wizard-body">${await steps[i].html()}<menu>${i > 0 ? '<button data-back class="ghost">Back</button>' : ''}<button data-skip class="ghost">Skip setup</button><button data-next class="primary">${
      i === steps.length - 1 ? 'Finish' : 'Next'
    }</button></menu></div>`;
    dlg.querySelector('[data-back]')?.addEventListener('click', () => {
      i--;
      void show();
    });
    dlg.querySelector('[data-skip]')!.addEventListener('click', finish);
    dlg.querySelector('[data-next]')!.addEventListener('click', async () => {
      await steps[i].leave?.();
      if (i === steps.length - 1) return finish();
      i++;
      void show();
    });
    await steps[i].enter?.(dlg);
  }

  async function finish(): Promise<void> {
    apply(await api.updateSettings({ firstRunDone: true }));
    dlg.close();
    resolveDone();
  }

  dlg.addEventListener('cancel', (e) => e.preventDefault());
  dlg.showModal();
  await show();
  return done;
}
