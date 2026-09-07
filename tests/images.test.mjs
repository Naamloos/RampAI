import assert from 'node:assert/strict';
import test from 'node:test';
import { Collection } from 'discord.js';
import DiscordImageCache, {
  discordImageKey,
  IMAGE_BYTE_LIMIT,
} from '../src/discord/image-cache.ts';
import OllamaService from '../src/llm/ollama.service.ts';
import { fitContext } from '../src/llm/context-budget.ts';
import MessageCreateEvent from '../src/events/message-create.event.ts';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
const url = 'https://cdn.discordapp.com/attachments/1/2/image.png';

test('image cache shares in-flight downloads and survives signed URL renewal', async (t) => {
  const cache = new DiscordImageCache();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls += 1;
    assert.equal(options.redirect, 'error');
    return new Response(png);
  });
  const [first, second] = await Promise.all([
    cache.get(`${url}?ex=1&hm=a`),
    cache.get(`${url}?hm=b&ex=2`),
  ]);
  assert.deepEqual(first, png);
  assert.equal(first, second);
  assert.equal(await cache.get(url.replace('cdn.discordapp.com', 'media.discordapp.net')), first);
  assert.equal(calls, 1);
  assert.equal(discordImageKey('https://example.com/image.png'), undefined);
  assert.equal(discordImageKey('http://cdn.discordapp.com/image.png'), undefined);
  assert.equal(await cache.get('https://127.0.0.1/image.png'), undefined);
  assert.equal(calls, 1);
});

test('image downloads reject oversized streams and invalid formats without caching failures', async (t) => {
  const cache = new DiscordImageCache();
  let mode = 'header';
  t.mock.method(globalThis, 'fetch', async () => {
    if (mode === 'header')
      return new Response(png, { headers: { 'content-length': String(IMAGE_BYTE_LIMIT + 1) } });
    if (mode === 'stream') return new Response(new Uint8Array(IMAGE_BYTE_LIMIT + 1));
    if (mode === 'invalid') return new Response('<html>not an image</html>');
    return new Response(png);
  });
  for (mode of ['header', 'stream', 'invalid']) {
    assert.equal(await cache.get(url), undefined);
    assert.equal(cache.entries.size, 0);
    assert.equal(cache.bytes, 0);
  }
  mode = 'valid';
  assert.deepEqual(await cache.get(url), png);
});

test('image cache caps bytes and entries and retains recently used images', async () => {
  const cache = new DiscordImageCache();
  cache.download = async () => new Uint8Array(IMAGE_BYTE_LIMIT);
  for (let i = 0; i < 9; i += 1) await cache.get(`${url}?version=${i}`);
  assert.equal(cache.bytes, 32 * 1024 * 1024);
  assert.equal(cache.entries.size, 8);
  const small = new DiscordImageCache();
  let calls = 0;
  small.download = async () => {
    calls += 1;
    return png;
  };
  for (let i = 0; i < 32; i += 1) await small.get(`${url}?version=${i}`);
  await small.get(`${url}?version=0`);
  await small.get(`${url}?version=32`);
  await small.get(`${url}?version=0`);
  assert.equal(calls, 33);
  assert.equal(small.entries.size, 32);
  assert.equal(small.entries.has(discordImageKey(`${url}?version=1`)), false);
});

test('chat images retain message association, share budgets, and reuse bytes across turns', async (t) => {
  const service = Object.create(OllamaService.prototype);
  service.imageCache = new DiscordImageCache();
  service.toOllamaMessage = (message) => ({ role: 'user', content: message.id });
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    downloads += 1;
    return new Response(png);
  });
  const chat = [
    {
      id: 'upload',
      attachments: new Collection([
        [
          'image',
          { id: 'image', name: 'image.png', size: png.length, contentType: 'image/png', url },
        ],
      ]),
      embeds: [],
    },
    {
      id: 'embed',
      attachments: new Collection(),
      embeds: [
        {
          image: {
            url: 'https://example.com/photo.png',
            proxyURL: 'https://images-ext-1.discordapp.net/external/photo.png',
          },
        },
      ],
    },
    { id: 'question', attachments: new Collection(), embeds: [] },
  ];
  const budget = { remaining: 3, imagesRemaining: 2 };
  const messages = await service.toOllamaMessagesWithAttachments(chat, budget);
  assert.deepEqual(messages[0].images[0], png);
  assert.deepEqual(messages[1].images[0], png);
  assert.equal(messages[2].images, undefined);
  assert.equal(budget.imagesRemaining, 0);
  await service.toOllamaMessagesWithAttachments(chat, budget);
  const next = await service.toOllamaMessagesWithAttachments(chat);
  assert.equal(downloads, 2);
  assert.equal(next[0].images[0], messages[0].images[0]);
  for (let i = 0; i < 3; i += 1) {
    const request = fitContext(messages, 6000, 100);
    assert.deepEqual(request[0].images[0], png);
  }
  assert.equal(downloads, 2);
});

test('context budget excludes image bytes and preserves the latest image with a follow-up question', () => {
  const image = new Uint8Array(1024 * 1024);
  const messages = [
    { role: 'system', content: 'Core instructions.' },
    ...Array.from({ length: 20 }, () => ({ role: 'user', content: 'old '.repeat(200) })),
    { role: 'user', content: 'Photo', images: [image] },
    { role: 'user', content: 'What is in that photo?' },
  ];
  const result = fitContext(messages, 4000, 100);
  assert.equal(result.at(-2).images[0], image);
  assert.equal(result.at(-1).content, 'What is in that photo?');
  assert.ok(result.length < messages.length);
  assert.ok(
    JSON.stringify(result, (key, value) => (key === 'images' ? undefined : value)).length +
      2048 +
      100 <=
      4000,
  );
});

test('profile picture can use an uploaded Discord image', async (t) => {
  let avatar;
  const handler = new MessageCreateEvent({
    user: {
      id: 'bot',
      setAvatar: async (image) => {
        avatar = image;
      },
    },
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(png));
  const message = {
    id: 'message',
    attachments: new Collection([
      [
        'image',
        { id: 'image', name: 'image.png', size: png.length, contentType: 'image/png', url },
      ],
    ]),
  };
  const result = await handler.executeAction({}, [message], {
    type: 'change_profile_picture',
    messageId: 'message',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(avatar, png);
});
