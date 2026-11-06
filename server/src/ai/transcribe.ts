import { config } from '../config.ts';
import { extFromMime } from '../lib/storage.ts';
import { recordTranscription } from '../services/usage.ts';

// Claude's Messages API does not take audio input, so voice messages are converted to text first
// with any OpenAI-compatible /audio/transcriptions endpoint (OpenAI, Groq, self-hosted Whisper...).

export function transcriptionEnabled(): boolean {
  return Boolean(config.stt.apiKey);
}

export async function transcribe(data: Buffer, mime: string, workspaceId: string): Promise<string | null> {
  if (!transcriptionEnabled()) return null;
  const baseMime = mime.split(';')[0].trim() || 'audio/ogg';
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(data)], { type: baseMime }), `voice.${extFromMime(baseMime)}`);
  form.set('model', config.stt.model);
  form.set('response_format', 'json');
  const res = await fetch(`${config.stt.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.stt.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Transcription failed (HTTP ${res.status}): ${detail}`);
  }
  const json = (await res.json()) as { text?: string };
  // Rough duration estimate for usage stats (~4 KB per second of compressed speech).
  await recordTranscription(workspaceId, data.length / 4000);
  return json.text?.trim() || null;
}
