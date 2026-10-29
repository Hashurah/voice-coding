// Optional cloud speech (OpenAI). Only used when the user has selected it and
// stored a key. Calls are made from the main process so the key never reaches
// the renderer. Audio sent here leaves the device; the UI says so.

const BASE = 'https://api.openai.com/v1';

export async function openaiTts(key: string, text: string, voice: string, speed: number): Promise<ArrayBuffer> {
  const res = await fetch(`${BASE}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: voice || 'alloy', input: text, speed, response_format: 'mp3' }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`OpenAI speech failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.arrayBuffer();
}

export async function openaiStt(key: string, audio: ArrayBuffer, mime: string): Promise<string> {
  const form = new FormData();
  form.append('model', 'gpt-4o-mini-transcribe');
  form.append('file', new Blob([audio], { type: mime }), mime.includes('wav') ? 'audio.wav' : 'audio.webm');
  const res = await fetch(`${BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`OpenAI transcription failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { text?: string };
  return json.text ?? '';
}
