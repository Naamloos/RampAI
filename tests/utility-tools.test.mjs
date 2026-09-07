import assert from 'node:assert/strict';
import test from 'node:test';
import { Collection } from 'discord.js';
import { calculate } from '../src/llm/calculate.ts';
import { executeRegisteredTool } from '../src/llm/tools.ts';
import { readAttachmentPage } from '../src/discord/read-attachment.ts';
import MessageCreateEvent from '../src/events/message-create.event.ts';

test('calculator respects precedence and rejects invalid or unsafe expressions', () => {
  for (const [expression, expected] of [
    ['2 + 3 * 4', 14], ['(2 + 3) * 4', 20], ['2^3^2', 512],
    ['-2^2', -4], ['2^-2', 0.25], ['10 % 3', 1], ['.5 + 1e2', 100.5],
  ]) assert.equal(calculate(expression), expected);
  for (const expression of ['1/0', '1%0', '2 +', '(2', '2 3', 'process.exit()', '1e999', '2**3', ''])
    assert.throws(() => calculate(expression));
});

test('file and attachment tools validate arguments before Discord dispatch', async () => {
  const actions = [];
  const context = { discord: async (action) => { actions.push(action); return { stop: false, result: { ok: true } }; } };
  for (const args of [{ filename: '../bad.txt', content: 'x' }, { filename: 'x.txt', content: '💀'.repeat(25001) }])
    assert.equal((await executeRegisteredTool('create_file', args, context)).result.ok, false);
  assert.equal(actions.length, 0);
  await executeRegisteredTool('create_file', { filename: 'empty.txt', content: '' }, context);
  assert.deepEqual(actions[0], { type: 'create_file', filename: 'empty.txt', content: '' });
  assert.equal((await executeRegisteredTool('read_attachment', { message_id: '1', attachment_id: '2', offset: -1 }, context)).result.ok, false);
  await executeRegisteredTool('read_attachment', { message_id: '1', attachment_id: '2' }, context);
  assert.equal(actions.at(-1).offset, 0);
});

const attachment = { id: '2', name: 'example.ts', size: 5000, contentType: 'application/octet-stream', url: 'https://cdn.discordapp.com/attachments/1/2/example.ts' };

test('attachment pages preserve contents and reject oversized, binary, and external input', async (t) => {
  const text = 'x'.repeat(3999) + '💀' + 'tail';
  let body = text;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++;
    assert.equal(options.redirect, 'error');
    return new Response(body);
  });
  const first = await readAttachmentPage(attachment, 0);
  const second = await readAttachmentPage(attachment, first.next_offset);
  assert.equal(first.content + second.content, text);
  assert.equal(second.next_offset, null);
  await assert.rejects(readAttachmentPage({ ...attachment, url: 'https://example.com/file' }, 0));
  assert.equal(calls, 2);
  body = 'x'.repeat(100001);
  await assert.rejects(readAttachmentPage(attachment, 0), /exceeds/);
  body = 'a\0b';
  await assert.rejects(readAttachmentPage(attachment, 0), /Binary/);
  body = new Uint8Array([0xff]);
  await assert.rejects(readAttachmentPage(attachment, 0));
});

test('reaction lookup fetches the requested channel message and forwards pagination', async () => {
  const event = Object.create(MessageCreateEvent.prototype);
  event.isStatusMessage = () => false;
  let options;
  const channel = { messages: { fetch: async (input) => {
    assert.deepEqual(input, { message: '123', force: true });
    return { id: '123', reactions: { cache: new Collection([['emoji', {
      emoji: { id: null, name: '👍' },
      users: { fetch: async (input) => {
        options = input;
        return new Collection([['456', { id: '456', username: 'someone', globalName: null, bot: false }]]);
      } },
    }]]) } };
  } } };
  const result = await event.executeAction(channel, [], {
    type: 'list_reaction_users', messageId: '123', emoji: '👍', limit: 1, after: '111', reactionType: 1,
  });
  assert.deepEqual(options, { limit: 1, after: '111', type: 1 });
  assert.equal(result.next_after, '456');
  assert.equal(result.users[0].id, '456');
});
