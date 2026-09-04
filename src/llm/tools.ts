import type { Tool } from 'ollama';

type ToolParameters = NonNullable<Tool['function']['parameters']>;

function tool(
  name: string,
  description: string,
  required: string[],
  properties: Record<string, unknown>,
): Tool {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required,
        properties,
      } as ToolParameters,
    },
  };
}

export type DiscordAction =
  | { type: 'reply_to_message'; messageId: string; content: string }
  | { type: 'add_reaction' | 'remove_reaction'; messageId: string; emoji: string }
  | { type: 'edit_message'; messageId: string; content: string }
  | { type: 'delete_message' | 'pin_message' | 'unpin_message'; messageId: string }
  | { type: 'change_nickname'; nickname: string }
  | { type: 'get_member_presence'; member: string }
  | { type: 'create_poll'; question: string; answers: string[]; durationHours: number }
  | { type: 'search_channel_history'; query: string; limit: number }
  | { type: 'schedule_message'; content: string; delayMinutes: number };

export interface AiResult {
  response?: string;
  latestMessageId?: string;
}

const messageId = { type: 'string', minLength: 1 };
const content = { type: 'string', minLength: 1 };
const emoji = {
  type: 'string',
  description:
    'Exact available custom emoji like <:name:id>, or a real Unicode emoji like 💀. Never use colon aliases or emoji names.',
  pattern: '^(?:<a?:[A-Za-z0-9_]+:[0-9]+>|[^\\x00-\\x7F]+)$',
};

export const tools: Tool[] = [
  tool('no_response', 'Send no public Discord response for this turn.', [], {}),
  tool(
    'reply_to_message',
    'Reply directly to a message in this channel.',
    ['message_id', 'content'],
    {
      message_id: messageId,
      content,
    },
  ),
  tool(
    'add_reaction',
    'Add one emoji reaction to a message in this channel.',
    ['message_id', 'emoji'],
    {
      message_id: messageId,
      emoji,
    },
  ),
  tool(
    'remove_reaction',
    'Remove your own matching reaction from a message in this channel.',
    ['message_id', 'emoji'],
    { message_id: messageId, emoji },
  ),
  tool(
    'edit_message',
    'Edit one of your own messages in this channel.',
    ['message_id', 'content'],
    {
      message_id: messageId,
      content,
    },
  ),
  tool('delete_message', 'Delete one of your own messages in this channel.', ['message_id'], {
    message_id: messageId,
  }),
  tool('pin_message', 'Pin a message in this channel.', ['message_id'], { message_id: messageId }),
  tool('unpin_message', 'Unpin a message in this channel.', ['message_id'], {
    message_id: messageId,
  }),
  tool('change_nickname', 'Change your own nickname in this Discord server.', ['nickname'], {
    nickname: { type: 'string', minLength: 1, maxLength: 32 },
  }),
  tool(
    'get_member_presence',
    'Get a server member’s current Discord status and activities, including what they are playing. Accepts their ID, username, or nickname.',
    ['member'],
    { member: { type: 'string', minLength: 1, maxLength: 100 } },
  ),
  tool('create_poll', 'Create a poll in this channel.', ['question', 'answers'], {
    question: { type: 'string', minLength: 1, maxLength: 300 },
    answers: {
      type: 'array',
      minItems: 2,
      maxItems: 10,
      items: { type: 'string', minLength: 1, maxLength: 55 },
    },
    duration_hours: { type: 'integer', minimum: 1, maximum: 168 },
  }),
  tool(
    'search_channel_history',
    'Search older messages in this channel when the supplied recent context is insufficient.',
    ['query'],
    {
      query: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    },
  ),
  tool(
    'schedule_message',
    'Schedule a message to be sent later in this channel. Use for reminders and delayed follow-ups.',
    ['content', 'delay_minutes'],
    {
      content,
      delay_minutes: { type: 'integer', minimum: 1, maximum: 43200 },
    },
  ),
  tool(
    'update_system_prompt',
    'Replace your persistent personality instructions after reflection. Preserve established identity unless experience justifies a gradual change.',
    ['markdown'],
    { markdown: { type: 'string', minLength: 1, maxLength: 12000 } },
  ),
  tool(
    'memory_search',
    'Search persistent memory before using, updating, or deduplicating remembered facts.',
    ['query'],
    {
      query: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
    },
  ),
  tool('memory_store', 'Store one concise durable fact for future conversations.', ['text'], {
    text: { type: 'string', minLength: 1, maxLength: 2000 },
  }),
  tool(
    'memory_update',
    'Replace an existing memory with a corrected or merged version.',
    ['id', 'text'],
    {
      id: { type: 'string', minLength: 1 },
      text: { type: 'string', minLength: 1, maxLength: 2000 },
    },
  ),
  tool('memory_delete', 'Delete a memory that is wrong, private, duplicated, or stale.', ['id'], {
    id: { type: 'string', minLength: 1 },
  }),
  tool('memory_recent', 'Inspect recently updated memories during reflection or cleanup.', [], {
    limit: { type: 'integer', minimum: 1, maximum: 20 },
  }),
];
