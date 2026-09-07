import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fitContext, boundedToolResult, contextLimits } from '../src/llm/context-budget.ts';
import ollama from 'ollama';
import { buildSystemPrompt } from '../src/constants/system.ts';
import { tools, summarizeToolResult } from '../src/llm/tools.ts';
import ScheduledMessageStore from '../src/discord/scheduled-message.store.ts';
import ElasticsearchMemoryStore from '../src/memory/elasticsearch-memory.store.ts';
import MessageCreateEvent from '../src/events/message-create.event.ts';
import OllamaService from '../src/llm/ollama.service.ts';

test('tool summaries include bounded parameters without code-fence injection or prompt disclosure', () => {
  const summary = summarizeToolResult('web_search', { ok: true }, { query: '```hello```' });
  assert.match(summary, /query/);
  assert.match(summary, /hello/);
  assert.equal((summary.match(/`/g) ?? []).length, 2);
  assert.ok(
    summarizeToolResult('web_search', { ok: true }, { query: 'x'.repeat(10000) }).length < 700,
  );
  assert.doesNotMatch(
    summarizeToolResult('update_system_prompt', { ok: true }, { markdown: 'private identity' }),
    /private identity/,
  );
});

test('request budgeting refreshes instructions, reserves output, and retries context overflow', async (t) => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    OLLAMA_NUM_CTX: '32768',
    OLLAMA_NUM_PREDICT: '1024',
    OLLAMA_ATTEMPTS: '1',
  });
  delete process.env.CONTEXT_CHAR_LIMIT;
  const service = Object.create(OllamaService.prototype);
  service.readSystemPrompt = async () => 'Updated identity; keep this exact instruction.';
  const messages = [
    { role: 'system', content: buildSystemPrompt('Old identity') },
    ...Array.from({ length: 100 }, (_, i) => ({
      role: 'user',
      content: `${i}: ${'old '.repeat(1000)}`,
    })),
    { role: 'user', content: 'sudo answer the newest question' },
  ];
  const requests = [];
  t.mock.method(ollama, 'chat', async (input) => {
    requests.push(input.messages);
    assert.equal(input.options.num_predict, 1024);
    assert.match(input.messages[0].content, /Updated identity/);
    assert.equal(input.messages.at(-1).content, 'sudo answer the newest question');
    assert.ok(
      Buffer.byteLength(JSON.stringify(input.messages)) +
        Buffer.byteLength(JSON.stringify(tools)) <=
        contextLimits().characterLimit,
    );
    if (requests.length === 1) throw new Error('input length exceeds context window');
    return { message: { role: 'assistant', content: 'done' } };
  });
  try {
    assert.equal((await service.chatWithTimeout(messages)).message.content, 'done');
    assert.equal(requests.length, 2);
    assert.ok(requests[1].length < requests[0].length);
    assert.match(messages[0].content, /Old identity/);
  } finally {
    for (const key of [
      'OLLAMA_NUM_CTX',
      'OLLAMA_NUM_PREDICT',
      'OLLAMA_ATTEMPTS',
      'CONTEXT_CHAR_LIMIT',
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test('default context fits native schemas and core prompt; reference data can be omitted', () => {
  const messages = [
    { role: 'system', content: buildSystemPrompt('Keep this identity.', 'x'.repeat(30000)) },
    { role: 'user', content: 'newest request' },
  ];
  const fitted = fitContext(
    messages,
    (8192 - 1024 - 512) * 3,
    Buffer.byteLength(JSON.stringify(tools)),
  );
  assert.match(fitted[0].content, /Keep this identity/);
  assert.match(fitted[0].content, /Sudo override/);
  assert.doesNotMatch(fitted[0].content, /<reference_context>/);
  assert.equal(fitted.at(-1).content, 'newest request');
});

test('context budget preserves core rules, newest user, and complete tool exchanges', () => {
  const messages = [{ role: 'system', content: 'Keep core rules.' }];
  for (let i = 0; i < 30; i += 1) {
    messages.push({ role: 'user', content: `older ${i} ${'x'.repeat(300)}` });
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'lookup', arguments: { id: i } } }],
    });
    messages.push({
      role: 'tool',
      tool_name: 'lookup',
      content: JSON.stringify({ value: 'x'.repeat(300) }),
    });
  }
  messages.push({ role: 'user', content: 'Newest question' });
  messages.push({
    role: 'assistant',
    content: '',
    thinking: 'private',
    tool_calls: [{ function: { name: 'lookup', arguments: {} } }],
  });
  messages.push({
    role: 'tool',
    tool_name: 'lookup',
    content: boundedToolResult({ ok: true, data: 'x'.repeat(10000) }),
  });
  const result = fitContext(messages, 1800, 100);
  assert.ok(JSON.stringify(result).length + 100 <= 1800);
  assert.match(result[0].content, /^Keep core rules\./);
  assert.ok(result.some((message) => message.content === 'Newest question'));
  assert.equal(result.at(-1).role, 'tool');
  assert.equal(result.at(-2).tool_calls[0].function.name, 'lookup');
  assert.doesNotMatch(JSON.stringify(result), /private/);
  assert.equal(messages[0].content, 'Keep core rules.');
  for (let i = 0; i < result.length; i += 1) {
    if (result[i].role === 'tool')
      assert.ok(result[i - 1].tool_calls || result[i - 1].role === 'tool');
  }
});

test('oversized tool results remain valid JSON and core instructions are never silently truncated', () => {
  const result = boundedToolResult({
    tool: 'get_message',
    ok: true,
    messageId: '123',
    data: '\\"'.repeat(10000),
  });
  assert.ok(result.length <= 4000);
  assert.equal(JSON.parse(result).messageId, '123');
  assert.equal(JSON.parse(result).truncated, true);
  assert.throws(
    () => fitContext([{ role: 'system', content: 'x'.repeat(10000) }], 1000, 100),
    /Core instructions/,
  );
});

test('events arriving while busy are drained, with bounded burst storage', async (t) => {
  const handler = new MessageCreateEvent({ user: { id: 'bot' } });
  t.mock.method(OllamaService, 'getInstance', () => ({ hasPendingMessages: () => false }));
  const turns = [];
  handler.readAndProcessChannel = async (channel, trigger, activity) => {
    turns.push({ trigger, activity });
    if (turns.length === 1) {
      for (let i = 0; i < 55; i += 1)
        await handler.processChannel(channel, 'reaction_add', `event ${i}`);
      assert.equal(handler.pendingActivities.length, 50);
    }
  };
  await handler.processChannel({}, 'message_event');
  assert.equal(turns.length, 2);
  assert.match(turns[1].activity, /5 earlier events coalesced/);
  assert.match(turns[1].activity, /event 54/);
  assert.equal(handler.processing, false);
});

test('reminder delivery checkpoints chunks and retains failures without losing other reminders', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rampai-delivery-'));
  const store = new ScheduledMessageStore();
  store.path = join(directory, 'reminders.json');
  const entry = (id, content) => ({
    id,
    content,
    createdAt: new Date().toISOString(),
    dueAt: '2000-01-01T00:00:00.000Z',
  });
  try {
    await store.restore(entry('a', 'first'));
    await store.restore(entry('b', 'other'));
    const sent = [];
    await assert.rejects(
      store.deliverDue(async (item) => {
        if (item.content === 'second') throw new Error('Discord unavailable');
        sent.push(item.content);
        return item.content === 'first' ? 'second' : undefined;
      }),
      /Some reminders/,
    );
    assert.deepEqual(sent.sort(), ['first', 'other']);
    const reloaded = new ScheduledMessageStore();
    reloaded.path = store.path;
    assert.deepEqual(
      (await reloaded.list()).map((item) => item.content),
      ['second'],
    );
    await Promise.all([
      reloaded.deliverDue(async (item) => {
        sent.push(item.content);
      }),
      reloaded.deliverDue(async () => assert.fail('Duplicate delivery')),
    ]);
    assert.deepEqual(await reloaded.list(), []);
    assert.equal(sent.filter((content) => content === 'second').length, 1);
    await writeFile(store.path, 'broken json');
    await assert.rejects(store.schedule('new', 1));
    assert.equal(await readFile(store.path, 'utf8'), 'broken json');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent identical memory writes deduplicate and capacity preserves existing facts', async () => {
  const previous = process.env.MEMORY_LIMIT;
  process.env.MEMORY_LIMIT = '1';
  const store = new ElasticsearchMemoryStore();
  store.ensureIndex = async () => {};
  const documents = new Map();
  store.request = async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    if (path.endsWith('/_search'))
      return {
        hits: {
          hits: [...documents]
            .filter(([, doc]) => doc.fingerprint === body.query.term.fingerprint)
            .map(([id]) => ({ _id: id })),
        },
      };
    if (path.endsWith('/_count')) return { count: documents.size };
    assert.match(path, /refresh=true/);
    const id = path.split('/').at(-1).split('?')[0];
    if (path.includes('/_create/')) documents.set(id, body);
    else if (init.method === 'DELETE') documents.delete(id);
    else if (body.doc) documents.set(id, { ...documents.get(id), ...body.doc });
    return { _id: id };
  };
  try {
    const ids = await Promise.all([store.store('Likes tea'), store.store(' likes   TEA ')]);
    assert.equal(ids[0], ids[1]);
    assert.equal(documents.size, 1);
    await assert.rejects(store.store('Likes coffee'), /capacity reached/);
    assert.equal(await store.update(ids[0], 'Likes green tea'), ids[0]);
    assert.equal(documents.get(ids[0]).text, 'Likes green tea');
    await store.delete(ids[0]);
    await store.store('Likes coffee');
    assert.equal(documents.size, 1);
  } finally {
    if (previous === undefined) delete process.env.MEMORY_LIMIT;
    else process.env.MEMORY_LIMIT = previous;
  }
});
