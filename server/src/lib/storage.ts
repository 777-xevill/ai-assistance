import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.ts';

// Media lives on local disk under DATA_DIR/media and is served at /media/... with unguessable names.
// Product photos must be publicly reachable because WhatsApp/Messenger fetch them by URL.

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/webm': 'webm',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'application/pdf': 'pdf',
};

export function extFromMime(mime: string | undefined, fallbackName?: string): string {
  const base = (mime ?? '').split(';')[0].trim().toLowerCase();
  if (EXT_BY_MIME[base]) return EXT_BY_MIME[base];
  const fromName = fallbackName?.split('.').pop()?.toLowerCase();
  if (fromName && /^[a-z0-9]{1,5}$/.test(fromName)) return fromName;
  return 'bin';
}

export function isImageMime(mime?: string): boolean {
  return !!mime && /^image\/(jpeg|png|webp|gif)/i.test(mime);
}

export interface SavedMedia {
  url: string;
  mime: string;
  size: number;
}

/**
 * Stores a file for a workspace. Photos are auto-rotated and downscaled to at most 1568px on the
 * long edge (Claude's recommended maximum), which also keeps them small for messaging apps.
 */
export async function saveMedia(
  workspaceId: string,
  data: Buffer,
  mime: string,
  opts: { name?: string; optimizeImage?: boolean } = {},
): Promise<SavedMedia> {
  let buf = data;
  let finalMime = (mime || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  if (opts.optimizeImage !== false && isImageMime(finalMime) && finalMime !== 'image/gif') {
    try {
      buf = await sharp(data)
        .rotate()
        .resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
      finalMime = 'image/jpeg';
    } catch {
      // Not a decodable image; keep the original bytes.
    }
  }
  const month = new Date().toISOString().slice(0, 7).replace('-', '');
  const rel = path.posix.join(workspaceId, month, `${crypto.randomUUID()}.${extFromMime(finalMime, opts.name)}`);
  const abs = path.join(config.mediaDir, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buf);
  return { url: `/media/${rel}`, mime: finalMime, size: buf.length };
}

/** Resolves a /media/... URL to a path inside the media directory (rejects traversal). */
export function mediaPath(url: string): string | null {
  if (!url.startsWith('/media/')) return null;
  const rel = decodeURIComponent(url.slice('/media/'.length));
  const abs = path.resolve(config.mediaDir, rel);
  const root = path.resolve(config.mediaDir) + path.sep;
  return abs.startsWith(root) ? abs : null;
}

export async function readMedia(url: string): Promise<Buffer | null> {
  const abs = mediaPath(url);
  if (!abs) return null;
  try {
    return await fs.readFile(abs);
  } catch {
    return null;
  }
}

export async function deleteMedia(url: string): Promise<void> {
  const abs = mediaPath(url);
  if (abs) await fs.rm(abs, { force: true });
}

/** Absolute URL for media, needed when a messaging platform must download it. */
export function publicUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `${config.appUrl}${url}`;
}

/** Downloads a remote file with a size cap. */
export async function fetchRemote(
  url: string,
  opts: { headers?: Record<string, string>; maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ data: Buffer; mime: string }> {
  const res = await fetch(url, {
    headers: opts.headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Download failed with HTTP ${res.status}`);
  const max = opts.maxBytes ?? 25 * 1024 * 1024;
  const len = Number(res.headers.get('content-length') || 0);
  if (len > max) throw new Error('File is too large');
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > max) throw new Error('File is too large');
  return { data, mime: res.headers.get('content-type') || 'application/octet-stream' };
}
