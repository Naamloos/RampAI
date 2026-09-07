import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Collection, MessageFlags } from 'discord.js';
import ScheduledMessageStore from '../src/discord/scheduled-message.store.ts';
import MessageCreateEvent from '../src/events/message-create.event.ts';
import OllamaService from '../src/llm/ollama.service.ts';
import { toolCatalog, tools } from '../src/llm/tools.ts';
import ElasticsearchMemoryStore from '../src/memory/elasticsearch-memory.store.ts';
import { buildSystemPrompt } from '../src/constants/system.ts';

test('Elasticsearch retries transient failures but not permanent errors', async (t) => {
  const store = new ElasticsearchMemoryStore();
  for (const statuses of [[400], [401], [404], [429, 200], [503, 200]]) {
    let calls = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => {
      const status = statuses[calls++] ?? 500;
      return new Response(JSON.stringify({ value: 'ok' }), { status });
    });
    if (statuses.at(-1) === 200) {
      assert.deepEqual(await store.request('/test'), { value: 'ok' });
    } else {
      await assert.rejects(store.request('/test'), new RegExp(`Elasticsearch ${statuses[0]}`));
    }
    assert.equal(calls, statuses.length);
    mock.mock.restore();
  }
});

test('attachment cache shares downloads, expires, bounds storage, and retries failures', async (t) => {
  const service = Object.create(OllamaService.prototype);
  service.attachmentCache = new Map();
  let calls = 0;
  const mock = t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response('x'.repeat(10_000));
  });
  const [first, second] = await Promise.all([
    service.readAttachment('one', 'https://example.test/one'),
    service.readAttachment('one', 'https://example.test/one'),
  ]);
  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal(first, `${'x'.repeat(2000)}\n[Attachment truncated]`);
  service.attachmentCache.get('one').expiresAt = 0;
  await service.readAttachment('one', 'https://example.test/one');
  assert.equal(calls, 2);
  for (let i = 0; i < 70; i += 1) {
    await service.readAttachment(String(i), 'https://example.test/file');
  }
  assert.equal(service.attachmentCache.size, 64);
  mock.mock.restore();
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  assert.equal(await service.readAttachment('failed', 'https://example.test/fail'), '');
  assert.equal(service.attachmentCache.has('failed'), false);
});

test('attachment context prefers recent files and shares its budget with incoming messages', async () => {
  const service = Object.create(OllamaService.prototype);
  const reads = [];
  service.toOllamaMessage = (message) => ({ role: 'user', content: message.id });
  service.readAttachment = async (id) => {
    reads.push(id);
    return 'text';
  };
  const chat = Array.from({ length: 5 }, (_, i) => ({
    id: String(i),
    attachments: new Collection([
      [
        String(i),
        {
          id: String(i),
          name: 'file.txt',
          url: 'https://example.test/file',
          size: 20,
          contentType: 'text/plain',
        },
      ],
    ]),
  }));
  const budget = { remaining: 3 };
  const messages = await service.toOllamaMessagesWithAttachments(chat, budget);
  assert.deepEqual(reads, ['4', '3', '2']);
  assert.equal(messages[0].content, '0');
  assert.match(messages[4].content, /Untrusted attachment content/);
  await service.toOllamaMessagesWithAttachments(chat, budget);
  assert.equal(reads.length, 3);
});

test('summary card updates in place, survives completion, and hides private results', async (t) => {
  const handler = new MessageCreateEvent({ user: { id: 'bot' } });
  const sent = [];
  const edits = [];
  const deleted = [];
  const channel = {
    guild: { emojis: { cache: new Collection() }, members: { cache: new Collection() } },
    send: async (payload) => {
      const index = sent.push(payload) - 1;
      return {
        delete: async () => deleted.push(index),
        edit: async (update) => edits.push(update),
      };
    },
  };
  t.mock.method(OllamaService, 'getInstance', () => ({
    getIsThinking: () => false,
    processFromChat: async (...args) => {
      const report = args[7];
      await report('memory_search', { ok: true, memories: [{ text: 'SECRET' }] });
      await report('update_system_prompt', { ok: false, error: 'SECRET' });
      for (let i = 0; i < 22; i += 1) {
        await report('get_message', { ok: true, message: { content: 'SECRET' } });
      }
      return {};
    },
  }));
  await handler.processMessages(channel, [], 'message_event');
  assert.equal(sent.length, 2);
  assert.equal(edits.length, 23);
  assert.deepEqual(deleted, [0]);
  assert.ok(sent[1].flags & MessageFlags.IsComponentsV2);
  assert.deepEqual(sent[1].allowedMentions, { parse: [] });
  assert.equal(
    handler.isStatusMessage({ author: { id: 'bot' }, components: sent[1].components }),
    true,
  );
  const initial = JSON.stringify(sent[1]);
  assert.match(initial, /1 results/);
  assert.match(JSON.stringify(edits[0]), /Failed/);
  assert.match(JSON.stringify(edits.at(-1)), /4 earlier calls omitted/);
  assert.doesNotMatch(JSON.stringify([sent, edits]), /SECRET/);
});

test('tool-result callback includes failures and terminal calls, skips reflection, and tolerates delivery failure', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const publicTurn of [true, false]) {
    const service = Object.create(OllamaService.prototype);
    Object.assign(service, {
      isThinking: false,
      approvedProfileImageUrls: new Set(),
      pendingMessages: [],
      appendChatState: async () => {},
      buildMessages: async () => [],
      insertPendingMessages: async () => undefined,
      chatWithTimeout: async () => ({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { function: { name: 'get_message', arguments: { message_id: 'missing' } } },
            { function: { name: 'no_response', arguments: {} } },
          ],
        },
      }),
      handleLoggedToolCall: async (call) => ({
        stop: call.function.name === 'no_response',
        result: { ok: call.function.name === 'no_response' },
      }),
    });
    const reports = [];
    await service.processFromChat(
      [],
      [],
      [],
      'test',
      undefined,
      undefined,
      publicTurn,
      async (name, result, args) => {
        reports.push({ name, result, args });
        throw new Error('Discord unavailable');
      },
    );
    assert.deepEqual(
      reports.map((report) => report.name),
      publicTurn ? ['get_message', 'no_response'] : [],
    );
    if (publicTurn) assert.deepEqual(reports[0].args, { message_id: 'missing' });
    assert.equal(service.isThinking, false);
  }
});

// Run with: node --import tsx --test tests/discord-tools.test.mjs
test('cancelled reminders stay cancelled across reloads and concurrent writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rampai-reminders-'));
  const previous = process.env.SCHEDULED_MESSAGES_PATH;
  process.env.SCHEDULED_MESSAGES_PATH = join(directory, 'scheduled.json');
  try {
    const store = new ScheduledMessageStore();
    const first = await store.schedule('first', 2);
    const [cancelled, second] = await Promise.all([
      store.cancel(first.id),
      store.schedule('second', 1),
    ]);
    assert.equal(cancelled, true);
    assert.equal(await store.cancel(first.id), false);
    assert.deepEqual(
      (await new ScheduledMessageStore().list()).map((entry) => entry.id),
      [second.id],
    );
  } finally {
    if (previous === undefined) delete process.env.SCHEDULED_MESSAGES_PATH;
    else process.env.SCHEDULED_MESSAGES_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('thinking card is excluded from context and removed after silence or failure', async (t) => {
  const handler = new MessageCreateEvent({ user: { id: 'bot' } });
  let payload;
  let deleted = 0;
  const channel = {
    guild: { emojis: { cache: new Collection() }, members: { cache: new Collection() } },
    send: async (options) => {
      payload = options;
      return {
        delete: async () => {
          deleted += 1;
        },
      };
    },
  };
  const service = { getIsThinking: () => false, processFromChat: async () => ({}) };
  t.mock.method(OllamaService, 'getInstance', () => service);
  await handler.processMessages(channel, [], 'message_event');
  assert.ok(payload.flags & MessageFlags.IsComponentsV2);
  assert.equal(payload.content, undefined);
  assert.equal(
    handler.isStatusMessage({ author: { id: 'bot' }, components: payload.components }),
    true,
  );
  assert.equal(
    handler.isStatusMessage({ author: { id: 'human' }, components: payload.components }),
    false,
  );
  assert.equal(deleted, 1);
  service.processFromChat = async () => {
    throw new Error('model unavailable');
  };
  await assert.rejects(handler.processMessages(channel, [], 'message_event'), /model unavailable/);
  assert.equal(deleted, 2);
});

test('poll tools fetch fresh channel state and reject ending another author’s poll', async () => {
  const handler = new MessageCreateEvent({ user: { id: 'bot' } });
  const target = {
    id: 'poll',
    author: { id: 'human', displayName: 'Human' },
    components: [],
    content: '',
    createdAt: new Date(),
    attachments: new Collection(),
    embeds: [],
    reactions: { cache: new Collection() },
    poll: {
      question: { text: 'Choose' },
      answers: new Collection([[1, { id: 1, text: 'Yes', voteCount: 3 }]]),
      resultsFinalized: false,
      allowMultiselect: false,
      end: async () => assert.fail('Must not end another author’s poll'),
    },
  };
  const channel = {
    messages: {
      fetch: async (options) => {
        assert.deepEqual(options, { message: 'poll', force: true });
        return target;
      },
    },
  };
  const result = await handler.executeAction(channel, [], {
    type: 'get_poll_results',
    messageId: 'poll',
  });
  assert.equal(result.message.poll.answers[0].votes, 3);
  assert.equal(result.message.poll.resultsFinalized, false);
  assert.equal(
    (await handler.executeAction(channel, [], { type: 'end_poll', messageId: 'poll' })).ok,
    false,
  );
});

test('web and Wikipedia tools return bounded search results', async (t) => {
  const previous = process.env.WEB_SEARCH_BASE_URL;
  process.env.WEB_SEARCH_BASE_URL = 'https://search.test';
  const service = Object.create(OllamaService.prototype);
  service.approvedProfileImageUrls = new Set();
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    const target = new URL(url);
    if (target.hostname === 'search.test' && target.pathname === '/search') {
      return new Response(
        '<rss><channel><item><title>Web</title><link>https://example.test</link><description>Result &amp; details</description></item></channel></rss>',
      );
    }
    if (target.hostname === 'search.test') {
      const metadata = JSON.stringify({
        t: 'Image',
        purl: 'https://example.test/image',
        murl: 'https://images.example.test/result.png',
      })
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;');
      return new Response(`<a class="iusc" m="${metadata}"></a>`);
    }
    if (target.hostname === 'www.wikidata.org') {
      return new Response(
        JSON.stringify({
          search: [
            {
              id: 'Q7259',
              label: 'Ada Lovelace',
              description: 'English mathematician',
              match: { text: 'Augusta Ada King' },
            },
          ],
        }),
      );
    }
    return new Response(
      JSON.stringify({
        query: {
          pages: [
            {
              title: 'Ada Lovelace',
              extract: 'Ada',
              index: 1,
              thumbnail: { source: 'https://upload.wikimedia.org/ada.jpg' },
            },
          ],
        },
      }),
    );
  });
  try {
    const web = await service.handleToolAction('web_search', { query: 'typescript', limit: 1 });
    const images = await service.handleToolAction('web_search', {
      query: 'typescript',
      category: 'images',
      limit: 1,
    });
    const wiki = await service.handleToolAction('wikipedia_search', {
      query: 'Ada',
      limit: 1,
    });
    const wikidata = await service.handleToolAction('wikidata_search', {
      query: 'Ada',
      language: 'en',
      limit: 1,
    });
    assert.equal(web.result.results[0].url, 'https://example.test');
    assert.equal(web.result.results[0].snippet, 'Result & details');
    assert.equal(images.result.results[0].image_url, 'https://images.example.test/result.png');
    assert.equal(wiki.result.results[0].snippet, 'Ada');
    assert.equal(wikidata.result.results[0].id, 'Q7259');
    assert.equal(wikidata.result.results[0].matched_text, 'Augusta Ada King');
    assert.match(requests[0], /q=typescript/);
    assert.match(requests[0], /format=rss/);
    assert.match(requests[1], /images\/search/);
    assert.match(requests[2], /gsrsearch=Ada/);
    assert.match(requests[3], /action=wbsearchentities/);
  } finally {
    if (previous === undefined) delete process.env.WEB_SEARCH_BASE_URL;
    else process.env.WEB_SEARCH_BASE_URL = previous;
  }
});

test('tool registry generates the native and system-prompt catalogs', () => {
  assert.equal(tools.length, toolCatalog.split('\n').length);
  for (const tool of tools)
    assert.match(toolCatalog, new RegExp(`^- ${tool.function.name}\\(`, 'm'));
  assert.match(
    buildSystemPrompt('', undefined, undefined, undefined, undefined, undefined, toolCatalog),
    /change_profile_picture/,
  );
});

test('profile pictures only accept image URLs returned by search in the current turn', async () => {
  const service = Object.create(OllamaService.prototype);
  service.approvedProfileImageUrls = new Set(['https://images.example.test/approved.png']);
  service.recentDiscordActions = new Map();
  let action;
  const execute = async (value) => {
    action = value;
    return { tool: value.type, ok: true };
  };
  const rejected = await service.handleToolAction(
    'change_profile_picture',
    { image_url: 'https://private.example.test/image.png' },
    execute,
  );
  assert.equal(rejected.result.ok, false);
  const accepted = await service.handleToolAction(
    'change_profile_picture',
    { image_url: 'https://images.example.test/approved.png' },
    execute,
  );
  assert.equal(accepted.result.ok, true);
  assert.equal(action.imageUrl, 'https://images.example.test/approved.png');
});
