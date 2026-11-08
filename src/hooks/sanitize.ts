const CLOSED = /<private>[\s\S]*?<\/private>/gi;
const OPEN = /<private>[\s\S]*$/i;
const DATA_IMAGE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

export function stripPrivate(text: string): string {
  return text.replace(CLOSED, '').replace(OPEN, '');
}

export function sanitizePrompt(text: string): string {
  return stripPrivate(text).trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max - 100);
  const tail = s.slice(-100);
  return `${head}\n<elided chars=${s.length - max}>\n${tail}`;
}

function sanitizeString(s: string, max: number): string {
  const noPrivate = stripPrivate(s);
  const noImages = noPrivate.replace(DATA_IMAGE, (m) => `<image elided bytes=${m.length - m.indexOf(',') - 1}>`);
  return truncate(noImages, max);
}

export function sanitizeToolPayload(value: unknown, maxChars = 16000, depth = 0): unknown {
  if (typeof value === 'string') return sanitizeString(value, maxChars);
  if (value === null || typeof value !== 'object' || depth > 20) return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeToolPayload(v, maxChars, depth + 1));
  const rec = value as Record<string, unknown>;
  if (rec.type === 'image' || rec.type === 'image_url') return { type: 'image', elided: true };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = sanitizeToolPayload(v, maxChars, depth + 1);
  return out;
}
