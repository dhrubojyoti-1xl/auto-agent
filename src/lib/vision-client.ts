/**
 * The Anthropic call that transcribes an image or a PDF.
 *
 * Kept apart from the verification logic so the checks can be tested without a
 * network or an API key — the checks are the part that makes this safe, and
 * they must be exercised on every build, not only when a key happens to exist.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  VISION_OUTPUT_FORMAT, VISION_SYSTEM_PROMPT, type VisionTable
} from './core/vision';

export type VisionFetch =
  | { ok: true; table: VisionTable }
  | { ok: false; reason: string };

/** Bounded so one unreadable image cannot consume a whole sync window. */
const TIMEOUT_MS = Number(process.env.VISION_TIMEOUT_MS || 45_000);

export function visionAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp'
};

export function visionMediaType(filename: string, mimeType: string): string | null {
  const m = (mimeType || '').toLowerCase();
  if (m === 'application/pdf') return 'application/pdf';
  if (Object.values(IMAGE_TYPES).includes(m)) return m;
  const f = (filename || '').toLowerCase();
  for (const [ext, type] of Object.entries(IMAGE_TYPES)) if (f.endsWith(ext)) return type;
  if (f.endsWith('.pdf')) return 'application/pdf';
  return null;
}

export async function transcribeTable(
  buffer: Buffer, mediaType: string
): Promise<VisionFetch> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, reason: 'No AI key is configured, so images are not read.' };

  const client = new Anthropic({ apiKey: key, timeout: TIMEOUT_MS });
  const data = buffer.toString('base64');
  const block = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data } };

  try {
    const res = await client.messages.create({
      model: process.env.ANTHROPIC_VISION_MODEL || process.env.ANTHROPIC_MODEL || 'claude-opus-5',
      max_tokens: 8000,
      system: VISION_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [block, { type: 'text', text: 'Transcribe the table in this file.' }]
      }],
      output_config: { format: VISION_OUTPUT_FORMAT }
    } as Parameters<typeof client.messages.create>[0]) as unknown as {
      content: { type: string; text?: string }[];
    };

    const text = res.content.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
    const parsed = JSON.parse(text) as {
      declared_rows: number; declared_columns: number; title: string;
      headers: string[]; rows: { text: string; confidence: number }[][];
    };
    return {
      ok: true,
      table: {
        declaredRows: Number(parsed.declared_rows ?? 0),
        declaredColumns: Number(parsed.declared_columns ?? 0),
        title: String(parsed.title ?? ''),
        headers: (parsed.headers || []).map(String),
        rows: (parsed.rows || []).map(r =>
          (r || []).map(c => ({ text: String(c?.text ?? ''), confidence: Number(c?.confidence ?? 0) })))
      }
    };
  } catch (e) {
    return {
      ok: false,
      reason: `The image could not be read: ${(e as Error).message}`.slice(0, 300)
    };
  }
}
