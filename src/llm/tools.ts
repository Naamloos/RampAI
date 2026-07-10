import type { Tool } from 'ollama';

type ToolParameters = NonNullable<Tool['function']['parameters']>;

function parameters(schema: Record<string, unknown>): ToolParameters {
  return schema;
}

export interface DiscordAction {
  type: 'add_reaction' | 'change_nickname' | 'reply_to_message';
  messageId?: string;
  emoji?: string;
  nickname?: string;
  content?: string;
}

export interface AiResult {
  response?: string;
}

export const aiResponseFormat = {
  type: 'object',
  additionalProperties: false,
  required: ['actions', 'response', 'no_response'],
  properties: {
    actions: {
      type: 'array',
      items: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'arguments'],
            properties: {
              name: { const: 'no_response' },
              arguments: {
                type: 'object',
                additionalProperties: false,
                properties: {},
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'arguments'],
            properties: {
              name: { const: 'reply_to_message' },
              arguments: {
                type: 'object',
                additionalProperties: false,
                required: ['message_id', 'content'],
                properties: {
                  message_id: { type: 'string', minLength: 1 },
                  content: { type: 'string', minLength: 1 },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'arguments'],
            properties: {
              name: { const: 'add_reaction' },
              arguments: {
                type: 'object',
                additionalProperties: false,
                required: ['message_id', 'emoji'],
                properties: {
                  message_id: { type: 'string', minLength: 1 },
                  emoji: {
                    type: 'string',
                    pattern: '^(?:<a?:[A-Za-z0-9_]+:[0-9]+>|[^\\x00-\\x7F]+)$',
                  },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'arguments'],
            properties: {
              name: { const: 'change_nickname' },
              arguments: {
                type: 'object',
                additionalProperties: false,
                required: ['nickname'],
                properties: {
                  nickname: { type: 'string', minLength: 1 },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'arguments'],
            properties: {
              name: { const: 'update_system_prompt' },
              arguments: {
                type: 'object',
                additionalProperties: false,
                required: ['markdown'],
                properties: {
                  markdown: { type: 'string', minLength: 1 },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'arguments'],
            properties: {
              name: { const: 'memory_search' },
              arguments: {
                type: 'object',
                additionalProperties: false,
                required: ['query'],
                properties: {
                  query: { type: 'string', minLength: 1 },
                  limit: { type: 'integer', minimum: 1, maximum: 10 },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'arguments'],
            properties: {
              name: { const: 'memory_store' },
              arguments: {
                type: 'object',
                additionalProperties: false,
                required: ['text'],
                properties: {
                  text: { type: 'string', minLength: 1 },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'arguments'],
            properties: {
              name: { const: 'memory_update' },
              arguments: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'text'],
                properties: {
                  id: { type: 'string', minLength: 1 },
                  text: { type: 'string', minLength: 1 },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'arguments'],
            properties: {
              name: { const: 'memory_delete' },
              arguments: {
                type: 'object',
                additionalProperties: false,
                required: ['id'],
                properties: {
                  id: { type: 'string', minLength: 1 },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'arguments'],
            properties: {
              name: { const: 'memory_recent' },
              arguments: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  limit: { type: 'integer', minimum: 1, maximum: 20 },
                },
              },
            },
          },
        ],
      },
    },
    response: { type: 'string' },
    no_response: { type: 'boolean' },
  },
} as const;

export const tools: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'no_response',
      description: 'Choose not to send a public Discord response for this turn.',
      parameters: parameters({
        type: 'object',
        additionalProperties: false,
        properties: {},
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'reply_to_message',
      description: 'Reply directly to a previous Discord message.',
      parameters: parameters({
        type: 'object',
        additionalProperties: false,
        required: ['message_id', 'content'],
        properties: {
          message_id: { type: 'string', minLength: 1 },
          content: { type: 'string', minLength: 1 },
        },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_reaction',
      description: 'Add one emoji reaction to a recent Discord message.',
      parameters: parameters({
        type: 'object',
        additionalProperties: false,
        required: ['message_id', 'emoji'],
        properties: {
          message_id: { type: 'string', minLength: 1 },
          emoji: {
            type: 'string',
            description:
              'Exact available custom emoji like <:name:id>, or a real Unicode emoji like 💀. Never use colon aliases like :skull: or plain names like skull.',
            pattern: '^(?:<a?:[A-Za-z0-9_]+:[0-9]+>|[^\\x00-\\x7F]+)$',
          },
        },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'change_nickname',
      description: 'Change your own Discord server nickname.',
      parameters: parameters({
        type: 'object',
        additionalProperties: false,
        required: ['nickname'],
        properties: {
          nickname: { type: 'string', minLength: 1 },
        },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_system_prompt',
      description: 'Replace your persistent custom instructions markdown.',
      parameters: parameters({
        type: 'object',
        additionalProperties: false,
        required: ['markdown'],
        properties: {
          markdown: { type: 'string', minLength: 1 },
        },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_search',
      description:
        'Search persistent memory before using, updating, or deduplicating remembered facts.',
      parameters: parameters({
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
        },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_store',
      description: 'Store one concise, durable fact that should help future conversations.',
      parameters: parameters({
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string', minLength: 1 },
        },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_update',
      description: 'Replace an existing memory with a corrected or more complete version.',
      parameters: parameters({
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text'],
        properties: {
          id: { type: 'string', minLength: 1 },
          text: { type: 'string', minLength: 1 },
        },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_delete',
      description: 'Delete an existing memory when it is wrong, private, or no longer wanted.',
      parameters: parameters({
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', minLength: 1 },
        },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_recent',
      description: 'Inspect recently updated memories for self-audit or cleanup.',
      parameters: parameters({
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
      }),
    },
  },
];
