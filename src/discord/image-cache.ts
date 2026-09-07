export const IMAGE_BYTE_LIMIT = 4 * 1024 * 1024;
const CACHE_BYTE_LIMIT = 32 * 1024 * 1024;
const CACHE_ENTRY_LIMIT = 32;

export function discordImageKey(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !/^(?:cdn\.discordapp\.com|media\.discordapp\.net|images-ext-\d+\.discordapp\.net)$/.test(
        url.hostname,
      )
    )
      return undefined;
    for (const name of ['ex', 'is', 'hm']) url.searchParams.delete(name);
    url.hash = '';
    if (url.pathname.startsWith('/attachments/')) url.hostname = 'cdn.discordapp.com';
    url.searchParams.sort();
    return url.toString();
  } catch {
    return undefined;
  }
}

export default class DiscordImageCache {
  private readonly entries = new Map<
    string,
    { bytes: number; data: Promise<Uint8Array | undefined> }
  >();
  private bytes = 0;

  get(url: string): Promise<Uint8Array | undefined> {
    const key = discordImageKey(url);
    if (!key) return Promise.resolve(undefined);
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.data;
    }
    while (
      this.entries.size >= CACHE_ENTRY_LIMIT ||
      this.bytes + IMAGE_BYTE_LIMIT > CACHE_BYTE_LIMIT
    ) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
    // Reserve the maximum download size, including downloads currently in flight.
    const entry: { bytes: number; data: Promise<Uint8Array | undefined> } = {
      bytes: IMAGE_BYTE_LIMIT,
      data: this.download(url),
    };
    entry.data = entry.data
      .then((data) => {
        if (this.entries.get(key) === entry) {
          this.bytes += data!.byteLength - entry.bytes;
          entry.bytes = data!.byteLength;
        }
        return data;
      })
      .catch(() => {
        if (this.entries.get(key) === entry) {
          this.bytes -= entry.bytes;
          this.entries.delete(key);
        }
        return undefined;
      });
    this.entries.set(key, entry);
    this.bytes += entry.bytes;
    return entry.data;
  }

  private async download(url: string): Promise<Uint8Array> {
    return await downloadImage(url);
  }
}

export async function downloadImage(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get('content-length')) > IMAGE_BYTE_LIMIT
  ) {
    await response.body?.cancel();
    throw new Error('Image unavailable or too large.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > IMAGE_BYTE_LIMIT) throw new Error('Image exceeds download limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const data = Buffer.concat(chunks, length);
  const png = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const webp = data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  if (!png && !jpeg && !webp) throw new Error('Unsupported image format.');
  return data;
}
