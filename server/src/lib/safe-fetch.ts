import dns from 'node:dns/promises';
import net from 'node:net';

// Fetching URLs that users type in (website import, catalog image URLs) must not reach
// internal services such as cloud metadata endpoints or the local network (SSRF).

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) links are supported');
  if (url.username || url.password) throw new Error('Links with credentials are not supported');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new Error('Could not resolve that address');
  if (addresses.some((a) => isPrivateIp(a.address))) throw new Error('That address is not allowed');
  return url;
}

export async function safeFetch(
  raw: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ data: Buffer; mime: string; finalUrl: string }> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIAssistanceBot/1.0)', Accept: '*/*' },
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = await assertPublicUrl(new URL(location, url).toString());
      continue;
    }
    if (!res.ok) throw new Error(`The site responded with HTTP ${res.status}`);
    if (Number(res.headers.get('content-length') || 0) > maxBytes) throw new Error('File is too large');
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error('File is too large');
        }
        chunks.push(value);
      }
    }
    return {
      data: Buffer.concat(chunks),
      mime: res.headers.get('content-type') || 'application/octet-stream',
      finalUrl: url.toString(),
    };
  }
  throw new Error('Too many redirects');
}
