/* eslint-disable @typescript-eslint/require-await */
import type { Tool } from 'ollama';
import { randomInt } from 'node:crypto';
import { calculate } from './calculate.js';

type ToolParameters = NonNullable<Tool['function']['parameters']>;
export interface ToolDefinition extends Tool {
  function: Tool['function'] & {
    name: string;
    description: string;
    parameters: ToolParameters;
  };
}
export interface ToolExecution {
  stop: boolean;
  result: unknown;
}

export type DiscordAction =
  | { type: 'create_file'; content: string; filename: string }
  | { type: 'read_attachment'; messageId: string; attachmentId: string; offset: number }
  | { type: 'list_reaction_users'; messageId: string; emoji: string; limit: number; after?: string; reactionType: 0 | 1 }
  | { type: 'reply_to_message'; messageId: string; content: string }
  | { type: 'add_reaction' | 'remove_reaction'; messageId: string; emoji: string }
  | { type: 'edit_message'; messageId: string; content: string }
  | { type: 'delete_message' | 'pin_message' | 'unpin_message'; messageId: string }
  | { type: 'change_nickname'; nickname: string }
  | { type: 'change_profile_picture'; imageUrl?: string; messageId?: string; attachmentId?: string }
  | { type: 'get_member_presence'; member: string }
  | { type: 'create_poll'; question: string; answers: string[]; durationHours: number }
  | { type: 'search_channel_history'; query: string; limit: number }
  | { type: 'schedule_message'; content: string; delayMinutes: number }
  | { type: 'get_message' | 'get_poll_results' | 'end_poll'; messageId: string }
  | { type: 'list_pinned_messages'; limit: number; before?: string }
  | { type: 'list_scheduled_messages' }
  | { type: 'cancel_scheduled_message'; id: string }
  | { type: 'generate_qr_code'; text: string };

export interface AiResult {
  response?: string;
  latestMessageId?: string;
}

export interface ToolContext {
  discord(action: DiscordAction): Promise<ToolExecution>;
  updateSystemPrompt(markdown: string): Promise<ToolExecution>;
  searchWeb(query: string, limit: number, category: 'general' | 'images'): Promise<unknown>;
  searchWikipedia(query: string, limit: number): Promise<unknown>;
  searchWikidata(query: string, limit: number, language: string): Promise<unknown>;
  readWebPage(url: string, maxCharacters: number): Promise<unknown>;
  changeProfilePicture(input: {
    imageUrl?: string;
    messageId?: string;
    attachmentId?: string;
  }): Promise<ToolExecution>;
  memory: {
    search(query: string, limit: number): Promise<unknown>;
    store(text: string): Promise<unknown>;
    update(id: string, text: string): Promise<unknown>;
    delete(id: string): Promise<unknown>;
    recent(limit: number): Promise<unknown>;
  };
}

export interface BotTool {
  definition: ToolDefinition;
  summary: string;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecution | undefined>;
  compactArguments?(args: Record<string, unknown>): Record<string, unknown>;
  compactResult?(result: unknown): unknown;
}

const messageId = { type: 'string', minLength: 1 };
const content = { type: 'string', minLength: 1 };
const emoji = {
  type: 'string',
  description:
    'Exact available custom emoji like <:name:id>, or a real Unicode emoji like 💀. Never use colon aliases or emoji names.',
  pattern: '^(?:<a?:[A-Za-z0-9_]+:[0-9]+>|[^\\x00-\\x7F]+)$',
};

export function defineTool(
  name: string,
  description: string,
  required: string[],
  properties: Record<string, unknown>,
  summary: string,
  execute: BotTool['execute'],
  options: Pick<BotTool, 'compactArguments' | 'compactResult'> = {},
): BotTool {
  return {
    definition: {
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
    },
    summary,
    execute,
    ...options,
  };
}

function discordTool(
  name: string,
  description: string,
  required: string[],
  properties: Record<string, unknown>,
  summary: string,
  action: (args: Record<string, unknown>) => DiscordAction | undefined,
): BotTool {
  return defineTool(name, description, required, properties, summary, async (args, context) => {
    const parsed = action(args);
    return parsed ? await context.discord(parsed) : undefined;
  });
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function integerArg(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  fallback = Number.NaN,
): number {
  const value = args[key];
  if (value === undefined) { return fallback; }
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : Number.NaN;
}

function messageAction(
  type:
    | 'delete_message'
    | 'pin_message'
    | 'unpin_message'
    | 'get_message'
    | 'get_poll_results'
    | 'end_poll',
) {
  return (args: Record<string, unknown>): DiscordAction | undefined => {
    const id = stringArg(args, 'message_id');
    return id ? { type, messageId: id } : undefined;
  };
}

export const toolRegistry: BotTool[] = [
  defineTool(
    'calculate',
    'Calculate an arithmetic expression using +, -, *, /, % (remainder), ^ (power), and parentheses. Uses floating-point numbers.',
    ['expression'],
    { expression: { type: 'string', minLength: 1, maxLength: 500 } },
    'Expression calculated.',
    async (args) => {
      const expression = stringArg(args, 'expression');
      if (!expression || expression.length > 500) return undefined;
      try {
        return { stop: false, result: { tool: 'calculate', ok: true, value: calculate(expression) } };
      } catch (error) {
        return { stop: false, result: { tool: 'calculate', ok: false, error: error instanceof Error ? error.message : 'Invalid expression.' } };
      }
    },
  ),
  defineTool(
    'create_file',
    'Post content as a UTF-8 file in this channel. Supply a filename, not a path. Maximum 100,000 UTF-8 bytes.',
    ['content', 'filename'],
    { content: { type: 'string', maxLength: 100000 }, filename: { type: 'string', minLength: 1, maxLength: 100 } },
    'File posted.',
    async (args, context) => {
      const filename = stringArg(args, 'filename');
      if (!filename || filename.length > 100 || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(filename) || /[. ]$/.test(filename) ||
        typeof args.content !== 'string' || Buffer.byteLength(args.content) > 100000) return undefined;
      return await context.discord({ type: 'create_file', filename, content: args.content });
    },
    { compactArguments: (args) => ({ filename: args.filename, contentLength: typeof args.content === 'string' ? args.content.length : 0 }) },
  ),
  discordTool(
    'read_attachment',
    'Read a UTF-8 text, code, or JSON attachment from a message in this channel. Get attachment IDs with get_message. Returns 4,000-character pages; pass next_offset to continue. Files are limited to 100,000 bytes.',
    ['message_id', 'attachment_id'],
    { message_id: messageId, attachment_id: messageId, offset: { type: 'integer', minimum: 0, maximum: 100000 } },
    'Attachment read.',
    (args) => {
      const id = stringArg(args, 'message_id');
      const attachmentId = stringArg(args, 'attachment_id');
      const offset = integerArg(args, 'offset', 0, 100000, 0);
      return id && attachmentId && Number.isFinite(offset) ? { type: 'read_attachment', messageId: id, attachmentId, offset } : undefined;
    },
  ),
  discordTool(
    'list_reaction_users',
    'List users who reacted to a message in this channel. Pass next_after for another page. reaction_type selects normal (default) or burst/super reactions.',
    ['message_id', 'emoji'],
    { message_id: messageId, emoji, limit: { type: 'integer', minimum: 1, maximum: 100 }, after: { type: 'string', pattern: '^[0-9]{1,20}$' }, reaction_type: { type: 'string', enum: ['normal', 'burst'] } },
    'Reaction users retrieved.',
    (args) => {
      const id = stringArg(args, 'message_id');
      const value = stringArg(args, 'emoji');
      const limit = integerArg(args, 'limit', 1, 100, 50);
      const after = stringArg(args, 'after');
      if (!id || !value || !Number.isFinite(limit) || ('after' in args && (!after || !/^[0-9]{1,20}$/.test(after))) ||
        (args.reaction_type !== undefined && args.reaction_type !== 'normal' && args.reaction_type !== 'burst')) return undefined;
      return { type: 'list_reaction_users', messageId: id, emoji: value, limit, ...(after ? { after } : {}), reactionType: args.reaction_type === 'burst' ? 1 : 0 };
    },
  ),
  defineTool(
    'read_web_page',
    'Read the main text of a public HTTP or HTTPS webpage. Use after web_search when snippets are insufficient.',
    ['url'],
    {
      url: { type: 'string', format: 'uri' },
      max_characters: { type: 'integer', minimum: 1000, maximum: 20000 },
    },
    'Webpage read.',
    async (args, context) => {
      const url = stringArg(args, 'url');
      const maxCharacters = integerArg(args, 'max_characters', 1000, 20000, 10000);
      return url && Number.isFinite(maxCharacters)
        ? { stop: false, result: await context.readWebPage(url, maxCharacters) }
        : undefined;
    },
    {
      compactResult: (result) =>
        isRecord(result) ? { tool: result.tool, ok: result.ok, url: result.url } : result,
    },
  ),
  defineTool(
    'rng',
    'Generate a cryptographically secure random integer, inclusive of both bounds.',
    ['min', 'max'],
    {
      min: { type: 'integer', minimum: -1000000000, maximum: 1000000000 },
      max: { type: 'integer', minimum: -1000000000, maximum: 1000000000 },
    },
    'Random number generated.',
    async (args) => {
      const min = integerArg(args, 'min', -1000000000, 1000000000);
      const max = integerArg(args, 'max', -1000000000, 1000000000);
      return Number.isFinite(min) && Number.isFinite(max) && min <= max
        ? {
          stop: false,
          result: { tool: 'rng', ok: true, min, max, value: randomInt(min, max + 1) },
        }
        : undefined;
    },
  ),
  discordTool(
    'generate_qr_code',
    'Generate and post a QR code image containing the supplied text or URL.',
    ['text'],
    { text: { type: 'string', minLength: 1, maxLength: 2000 } },
    'QR code generated.',
    (args) => {
      const text = stringArg(args, 'text');
      return text && text.length <= 2000 ? { type: 'generate_qr_code', text } : undefined;
    },
  ),
  defineTool(
    'current_time',
    'Get the current time in an IANA timezone. Defaults to UTC.',
    [],
    { timezone: { type: 'string', minLength: 1, maxLength: 100 } },
    'Current time retrieved.',
    async (args) => currentDateTime(args, 'time'),
  ),
  defineTool(
    'current_date',
    'Get the current calendar date in an IANA timezone. Defaults to UTC.',
    [],
    { timezone: { type: 'string', minLength: 1, maxLength: 100 } },
    'Current date retrieved.',
    async (args) => currentDateTime(args, 'date'),
  ),
  discordTool(
    'get_message',
    'Fetch a current message by ID in this channel, including attachments, embeds, reactions, and poll results.',
    ['message_id'],
    { message_id: messageId },
    'Message retrieved.',
    messageAction('get_message'),
  ),
  discordTool(
    'list_pinned_messages',
    'Read pinned messages in this channel. Use next_before to retrieve another page when hasMore is true.',
    [],
    {
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      before: {
        type: 'string',
        description: 'ISO timestamp returned as next_before by the previous page.',
      },
    },
    'Pinned messages retrieved.',
    (args) => {
      const limit = integerArg(args, 'limit', 1, 50, 20);
      const before = stringArg(args, 'before');
      return Number.isFinite(limit) &&
        (!('before' in args) || (before && Number.isFinite(Date.parse(before))))
        ? { type: 'list_pinned_messages', limit, ...(before ? { before } : {}) }
        : undefined;
    },
  ),
  discordTool(
    'get_poll_results',
    'Fetch current vote counts and finalization status for a poll in this channel.',
    ['message_id'],
    { message_id: messageId },
    'Poll results retrieved.',
    messageAction('get_poll_results'),
  ),
  discordTool(
    'end_poll',
    'End a poll created by you in this channel. Only do this when requested.',
    ['message_id'],
    { message_id: messageId },
    'Poll ended.',
    messageAction('end_poll'),
  ),
  discordTool(
    'list_scheduled_messages',
    'List pending reminders with IDs and due times before cancelling one.',
    [],
    {},
    'Pending reminders retrieved.',
    () => ({ type: 'list_scheduled_messages' }),
  ),
  discordTool(
    'cancel_scheduled_message',
    'Cancel a pending reminder using an ID returned by schedule_message or list_scheduled_messages.',
    ['id'],
    { id: { type: 'string', minLength: 1 } },
    'Reminder cancelled.',
    (args) => {
      const id = stringArg(args, 'id');
      return id ? { type: 'cancel_scheduled_message', id } : undefined;
    },
  ),
  defineTool(
    'no_response',
    'Send no public Discord response for this turn.',
    [],
    {},
    'No additional reply.',
    async () => ({ stop: true, result: { tool: 'no_response', ok: true } }),
  ),
  ...(['reply_to_message', 'edit_message'] as const).map((name) =>
    discordTool(
      name,
      name === 'reply_to_message'
        ? 'Reply directly to a message in this channel.'
        : 'Edit one of your own messages in this channel.',
      ['message_id', 'content'],
      { message_id: messageId, content },
      name === 'reply_to_message' ? 'Reply sent.' : 'Message edited.',
      (args) => {
        const id = stringArg(args, 'message_id');
        const value = stringArg(args, 'content');
        return id && value ? { type: name, messageId: id, content: value } : undefined;
      },
    ),
  ),
  ...(['add_reaction', 'remove_reaction'] as const).map((name) =>
    discordTool(
      name,
      name === 'add_reaction'
        ? 'Add one emoji reaction to a message in this channel.'
        : 'Remove your own matching reaction from a message in this channel.',
      ['message_id', 'emoji'],
      { message_id: messageId, emoji },
      name === 'add_reaction' ? 'Reaction added.' : 'Own reaction removed.',
      (args) => {
        const id = stringArg(args, 'message_id');
        const value = stringArg(args, 'emoji');
        return id && value ? { type: name, messageId: id, emoji: value } : undefined;
      },
    ),
  ),
  ...(['delete_message', 'pin_message', 'unpin_message'] as const).map((name) =>
    discordTool(
      name,
      `${name === 'delete_message' ? 'Delete' : name === 'pin_message' ? 'Pin' : 'Unpin'} ${name === 'delete_message' ? 'one of your own' : 'a'} message${name === 'delete_message' ? '' : ' in this channel'}.`,
      ['message_id'],
      { message_id: messageId },
      name === 'delete_message'
        ? 'Message deleted.'
        : name === 'pin_message'
          ? 'Message pinned.'
          : 'Message unpinned.',
      messageAction(name),
    ),
  ),
  discordTool(
    'change_nickname',
    'Change your own nickname in this Discord server.',
    ['nickname'],
    { nickname: { type: 'string', minLength: 1, maxLength: 32 } },
    'Nickname changed.',
    (args) => {
      const nickname = stringArg(args, 'nickname');
      return nickname && nickname.length <= 32 ? { type: 'change_nickname', nickname } : undefined;
    },
  ),
  defineTool(
    'change_profile_picture',
    'Change your global Discord profile picture. Use image_url only from a web_search or wikipedia_search result in this turn, or message_id for an uploaded image.',
    [],
    {
      image_url: { type: 'string', format: 'uri' },
      message_id: messageId,
      attachment_id: { type: 'string', minLength: 1 },
    },
    'Profile picture changed.',
    async (args, context) => {
      const imageUrl = stringArg(args, 'image_url');
      const messageIdValue = stringArg(args, 'message_id');
      const attachmentId = stringArg(args, 'attachment_id');
      if (Boolean(imageUrl) === Boolean(messageIdValue) || (attachmentId && !messageIdValue)) { return undefined; }
      return await context.changeProfilePicture({
        ...(imageUrl ? { imageUrl } : {}),
        ...(messageIdValue ? { messageId: messageIdValue } : {}),
        ...(attachmentId ? { attachmentId } : {}),
      });
    },
  ),
  discordTool(
    'get_member_presence',
    'Get a server member’s current Discord status and activities, including what they are playing. Accepts their ID, username, or nickname.',
    ['member'],
    { member: { type: 'string', minLength: 1, maxLength: 100 } },
    'Member presence retrieved.',
    (args) => {
      const member = stringArg(args, 'member');
      return member && member.length <= 100 ? { type: 'get_member_presence', member } : undefined;
    },
  ),
  discordTool(
    'create_poll',
    'Create a poll in this channel.',
    ['question', 'answers'],
    {
      question: { type: 'string', minLength: 1, maxLength: 300 },
      answers: {
        type: 'array',
        minItems: 2,
        maxItems: 10,
        items: { type: 'string', minLength: 1, maxLength: 55 },
      },
      duration_hours: { type: 'integer', minimum: 1, maximum: 168 },
    },
    'Poll created.',
    (args) => {
      const question = stringArg(args, 'question');
      const answers = Array.isArray(args.answers)
        ? args.answers.filter(
          (answer): answer is string => typeof answer === 'string' && !!answer.trim(),
        )
        : [];
      const durationHours = integerArg(args, 'duration_hours', 1, 168, 24);
      return question &&
        question.length <= 300 &&
        answers.length >= 2 &&
        answers.length <= 10 &&
        answers.every((answer) => answer.length <= 55) &&
        Number.isFinite(durationHours)
        ? { type: 'create_poll', question, answers, durationHours }
        : undefined;
    },
  ),
  discordTool(
    'search_channel_history',
    'Search older messages in this channel when the supplied recent context is insufficient.',
    ['query'],
    {
      query: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    },
    'Channel history searched.',
    (args) => {
      const query = stringArg(args, 'query');
      const limit = integerArg(args, 'limit', 1, 20, 10);
      return query && Number.isFinite(limit)
        ? { type: 'search_channel_history', query, limit }
        : undefined;
    },
  ),
  defineTool(
    'web_search',
    'Search the public internet. Use category=images when looking for a profile picture or other image.',
    ['query'],
    {
      query: { type: 'string', minLength: 1, maxLength: 500 },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
      category: { type: 'string', enum: ['general', 'images'] },
    },
    'Internet searched.',
    async (args, context) => {
      const query = stringArg(args, 'query');
      const limit = integerArg(args, 'limit', 1, 10, 5);
      const category = args.category ?? 'general';
      if (
        !query ||
        query.length > 500 ||
        !Number.isFinite(limit) ||
        (category !== 'general' && category !== 'images')
      ) { return undefined; }
      return { stop: false, result: await context.searchWeb(query, limit, category) };
    },
    { compactResult: compactResults },
  ),
  defineTool(
    'wikipedia_search',
    'Search English Wikipedia and return matching articles, snippets, and available lead images.',
    ['query'],
    {
      query: { type: 'string', minLength: 1, maxLength: 500 },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
    },
    'Wikipedia searched.',
    async (args, context) => {
      const query = stringArg(args, 'query');
      const limit = integerArg(args, 'limit', 1, 10, 5);
      return query && query.length <= 500 && Number.isFinite(limit)
        ? { stop: false, result: await context.searchWikipedia(query, limit) }
        : undefined;
    },
    { compactResult: compactResults },
  ),
  defineTool(
    'wikidata_search',
    'Search Wikidata entities by label or alias and return stable entity IDs, descriptions, and canonical URLs.',
    ['query'],
    {
      query: { type: 'string', minLength: 1, maxLength: 500 },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
      language: {
        type: 'string',
        pattern: '^[a-z]{2,3}(?:-[a-z0-9]+)*$',
        description: 'Wikimedia language code. Defaults to en.',
      },
    },
    'Wikidata searched.',
    async (args, context) => {
      const query = stringArg(args, 'query');
      const limit = integerArg(args, 'limit', 1, 10, 5);
      const language = stringArg(args, 'language') ?? 'en';
      return query &&
        query.length <= 500 &&
        Number.isFinite(limit) &&
        /^[a-z]{2,3}(?:-[a-z0-9]+)*$/.test(language)
        ? { stop: false, result: await context.searchWikidata(query, limit, language) }
        : undefined;
    },
    { compactResult: compactResults },
  ),
  discordTool(
    'schedule_message',
    'Schedule a message to be sent later in this channel. Use for reminders and delayed follow-ups.',
    ['content', 'delay_minutes'],
    { content, delay_minutes: { type: 'integer', minimum: 1, maximum: 43200 } },
    'Reminder scheduled.',
    (args) => {
      const value = stringArg(args, 'content');
      const delayMinutes = integerArg(args, 'delay_minutes', 1, 43200);
      return value && Number.isFinite(delayMinutes)
        ? { type: 'schedule_message', content: value, delayMinutes }
        : undefined;
    },
  ),
  defineTool(
    'update_system_prompt',
    'Adapt and replace your persistent custom instructions with the complete revised markdown whenever you judge it appropriate, including during ordinary conversation and silent reflection. This edits custom instructions, not fixed core rules.',
    ['markdown'],
    { markdown: { type: 'string', minLength: 1, maxLength: 12000 } },
    'Custom instructions updated.',
    async (args, context) => {
      const markdown = stringArg(args, 'markdown');
      return markdown && markdown.length <= 12000
        ? await context.updateSystemPrompt(markdown)
        : undefined;
    },
    {
      compactArguments: (args) => ({
        markdownLength: typeof args.markdown === 'string' ? args.markdown.length : 0,
      }),
    },
  ),
  defineTool(
    'memory_search',
    'Search persistent memory when relevant supplied memories are insufficient, or to find an existing fact before correcting or deduplicating it.',
    ['query'],
    {
      query: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
    },
    'Memories searched.',
    async (args, context) => {
      const query = stringArg(args, 'query');
      const limit = integerArg(args, 'limit', 1, 10, 5);
      return query && query.length <= 800 && Number.isFinite(limit)
        ? {
          stop: false,
          result: {
            tool: 'memory_search',
            ok: true,
            memories: await context.memory.search(query, limit),
          },
        }
        : undefined;
    },
    { compactResult: compactMemorySearch },
  ),
  defineTool(
    'memory_store',
    'Proactively store one useful fact. Include who it concerns and dates where useful; update an existing matching memory instead of duplicating it.',
    ['text'],
    { text: { type: 'string', minLength: 1, maxLength: 2000 } },
    'Memory stored.',
    async (args, context) => {
      const text = stringArg(args, 'text');
      return text && text.length <= 2000
        ? {
          stop: false,
          result: { tool: 'memory_store', ok: true, id: await context.memory.store(text) },
        }
        : undefined;
    },
    { compactArguments: compactMemoryText },
  ),
  defineTool(
    'memory_update',
    'Replace an existing memory with a corrected or merged version.',
    ['id', 'text'],
    {
      id: { type: 'string', minLength: 1 },
      text: { type: 'string', minLength: 1, maxLength: 2000 },
    },
    'Memory updated.',
    async (args, context) => {
      const id = stringArg(args, 'id');
      const text = stringArg(args, 'text');
      return id && text && text.length <= 2000
        ? {
          stop: false,
          result: { tool: 'memory_update', ok: true, id: await context.memory.update(id, text) },
        }
        : undefined;
    },
    { compactArguments: compactMemoryText },
  ),
  defineTool(
    'memory_delete',
    'Delete a memory that is wrong, private, duplicated, or stale.',
    ['id'],
    { id: { type: 'string', minLength: 1 } },
    'Memory deleted.',
    async (args, context) => {
      const id = stringArg(args, 'id');
      return id
        ? {
          stop: false,
          result: { tool: 'memory_delete', ok: true, id: await context.memory.delete(id) },
        }
        : undefined;
    },
  ),
  defineTool(
    'memory_recent',
    'Inspect recently updated memories during reflection or cleanup.',
    [],
    { limit: { type: 'integer', minimum: 1, maximum: 20 } },
    'Recent memories retrieved.',
    async (args, context) => {
      const limit = integerArg(args, 'limit', 1, 20, 10);
      return Number.isFinite(limit)
        ? {
          stop: false,
          result: {
            tool: 'memory_recent',
            ok: true,
            memories: await context.memory.recent(limit),
          },
        }
        : undefined;
    },
    { compactResult: compactMemories },
  ),
];

function currentDateTime(
  args: Record<string, unknown>,
  kind: 'date' | 'time',
): ToolExecution | undefined {
  const timezone = stringArg(args, 'timezone') ?? 'UTC';
  try {
    const now = new Date();
    const value = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      ...(kind === 'date'
        ? { year: 'numeric', month: '2-digit', day: '2-digit' }
        : { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }),
    }).format(now);
    return {
      stop: false,
      result: { tool: `current_${kind}`, ok: true, timezone, value, iso: now.toISOString() },
    };
  } catch {
    return undefined;
  }
}

function compactResults(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.results)) { return result; }
  return { tool: result.tool, ok: result.ok, count: result.results.length };
}

function compactMemories(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.memories)) { return result; }
  return { tool: result.tool, ok: result.ok, count: result.memories.length };
}

function compactMemorySearch(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.memories)) { return result; }
  return {
    tool: result.tool,
    ok: result.ok,
    count: result.memories.length,
    ids: result.memories.flatMap((memory) => (isRecord(memory) && memory.id ? [memory.id] : [])),
  };
}

function compactMemoryText(args: Record<string, unknown>): Record<string, unknown> {
  return typeof args.text === 'string'
    ? { ...args, text: `${args.text.slice(0, 200)}${args.text.length > 200 ? '…' : ''}` }
    : args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const byName = new Map(toolRegistry.map((entry) => [entry.definition.function.name, entry]));
export const tools: ToolDefinition[] = toolRegistry.map((entry) => entry.definition);
export const toolCatalog = toolRegistry
  .map((entry) => {
    const parameters = entry.definition.function.parameters;
    const required = new Set(parameters.required ?? []);
    const names = Object.keys(parameters.properties ?? {}).map((name) =>
      required.has(name) ? name : `[${name}]`,
    );
    return `- ${entry.definition.function.name}(${names.join(', ')}): ${entry.definition.function.description}`;
  })
  .join('\n');

export async function executeRegisteredTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecution> {
  const entry = byName.get(name);
  const parameters = entry?.definition.function.parameters;
  const allowed = new Set(Object.keys(parameters?.properties ?? {}));
  const required = parameters?.required ?? [];
  if (
    !entry ||
    !Object.keys(args).every((key) => allowed.has(key)) ||
    !required.every((key) => key in args)
  ) { return invalidArguments(name); }
  return (await entry.execute(args, context)) ?? invalidArguments(name);
}

export function compactToolArguments(name: string, args: Record<string, unknown>) {
  return byName.get(name)?.compactArguments?.(args) ?? args;
}
export function compactToolResult(name: string, result: unknown) {
  return byName.get(name)?.compactResult?.(result) ?? result;
}

export function summarizeToolResult(
  name: string,
  result: unknown,
  args?: Record<string, unknown>,
): string {
  const entry = byName.get(name);
  const data = isRecord(result) ? result : {};
  const count = ['messages', 'memories', 'results']
    .flatMap((key) => {
      const value = data[key];
      return Array.isArray(value) ? [value.length] : [];
    })
    .at(0);
  const json = args === undefined ? '' : JSON.stringify(compactToolArguments(name, args));
  // Keep user-controlled values inside inline code, with Discord mentions disabled by the sender.
  const parameters = json
    ? ` \`${(json.length > 500 ? `${json.slice(0, 499)}…` : json).replace(/`/g, 'ˋ')}\``
    : '';
  return `**${entry ? name : 'unknown_tool'}**${parameters} — ${data.ok === true ? 'Success' : 'Failed'}.${data.ok === true && entry ? ` ${entry.summary}${count === undefined ? '' : ` ${count} results.`}` : ''}`;
}

function invalidArguments(name: string): ToolExecution {
  return {
    stop: false,
    result: {
      tool: name,
      ok: false,
      error: 'Invalid tool arguments. Use the exact schema for this tool and no extra keys.',
    },
  };
}
