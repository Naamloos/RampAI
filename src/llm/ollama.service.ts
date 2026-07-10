import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Emoji, GuildMember, Message } from 'discord.js';
import type { Message as OllamaMessage, ToolCall } from 'ollama';
import ollama from 'ollama';
import { buildSystemPrompt } from '../constants/system.js';
import ElasticsearchMemoryStore from '../memory/elasticsearch-memory.store.js';
import { aiResponseFormat, tools } from './tools.js';
import type { AiResult, DiscordAction } from './tools.js';

const DEFAULT_SYSTEM_PROMPT = `# Custom Instructions

No custom identity has been defined yet.
`;

interface ChatStateEntry {
  action: 'run_start' | 'discord_message' | 'respond' | 'no_response' | 'tool_call' | 'tool_result';
  at: string;
  trigger?: string;
  response?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  messages?: unknown[];
  result?: unknown;
}

type JsonAction =
  | { name: 'no_response'; arguments: Record<string, never> }
  | { name: 'reply_to_message'; arguments: { message_id: string; content: string } }
  | { name: 'add_reaction'; arguments: { message_id: string; emoji: string } }
  | { name: 'change_nickname'; arguments: { nickname: string } }
  | { name: 'update_system_prompt'; arguments: { markdown: string } }
  | { name: 'memory_search'; arguments: { query: string; limit?: number } }
  | { name: 'memory_store'; arguments: { text: string } }
  | { name: 'memory_update'; arguments: { id: string; text: string } }
  | { name: 'memory_delete'; arguments: { id: string } }
  | { name: 'memory_recent'; arguments: { limit?: number } };

interface JsonAiResult {
  actions: JsonAction[];
  response: string;
  no_response: boolean;
}

export default class OllamaService {
  private static instance: OllamaService;
  private readonly memory = new ElasticsearchMemoryStore();
  private readonly pendingMessages: Message[] = [];
  private readonly systemPromptPath = process.env.SYSTEM_PROMPT_PATH ?? 'system-prompt.md';
  private readonly chatStatePath = process.env.CHAT_STATE_PATH ?? 'chat-state.json';
  private chatStateCache?: ChatStateEntry[];
  private systemPromptCache?: string;
  private isThinking = false;

  private constructor() {
    // Private constructor to prevent direct instantiation
  }

  public static getInstance(): OllamaService {
    if (!OllamaService.instance) {
      OllamaService.instance = new OllamaService();
    }

    return OllamaService.instance;
  }

  public getIsThinking(): boolean {
    return this.isThinking;
  }

  public addIncomingMessage(message: Message): void {
    this.pendingMessages.push(message);
    console.log(`Queued incoming message while thinking: ${message.id}`);
  }

  public async hasProcessedLatestMessage(messageId: string): Promise<boolean> {
    const state = await this.readChatState();
    return state.some((entry) => {
      if (entry.action !== 'run_start' || !entry.result || typeof entry.result !== 'object') {
        return false;
      }

      return (entry.result as { latestMessageId?: unknown }).latestMessageId === messageId;
    });
  }

  public async recordDiscordMessage(message: Message, trigger: string): Promise<void> {
    await this.appendChatState({
      action: 'discord_message',
      at: new Date().toISOString(),
      trigger,
      messages: [this.serializeMessage(message)],
    });
  }

  public async processFromChat(
    chat: Message[],
    emojis?: Emoji[],
    members?: GuildMember[],
    trigger = 'message',
    executeAction?: (action: DiscordAction) => Promise<unknown>,
  ): Promise<AiResult | undefined> {
    if (this.isThinking) {
      return undefined;
    }

    this.isThinking = true;

    try {
      await this.appendChatState({
        action: 'run_start',
        at: new Date().toISOString(),
        trigger,
        messages: chat.map((message) => this.serializeMessage(message, 500)),
        result: {
          messageCount: chat.length,
          latestMessageId: chat.at(-1)?.id,
          latestMessageAuthorId: chat.at(-1)?.author.id,
        },
      });
      const messages = await this.buildMessages(chat, trigger, emojis, members);

      const maxToolSteps = Number(process.env.MAX_TOOL_STEPS ?? 8);
      for (let i = 0; i < maxToolSteps; i += 1) {
        this.insertPendingMessages(messages);
        const response = await this.chatWithTimeout(messages);

        messages.push(response.message);
        const toolCall = response.message.tool_calls?.[0];

        if (!toolCall) {
          const jsonResult = this.parseJsonResult(response.message.content);
          if (!jsonResult) {
            await this.appendChatState({
              action: 'no_response',
              at: new Date().toISOString(),
              trigger,
              result: { reason: 'invalid_json_output' },
            });
            messages.push({
              role: 'user',
              content:
                'Your previous response did not match the required JSON schema. Return only the required JSON object with actions, response, and no_response.',
            });
            continue;
          }

          const actionResults = [];
          for (const action of jsonResult.actions) {
            await this.appendChatState({
              action: 'tool_call',
              at: new Date().toISOString(),
              trigger,
              tool: action.name,
              arguments: action.arguments,
            });
            const toolResult = await this.handleToolAction(
              action.name,
              action.arguments,
              executeAction,
            );
            await this.appendChatState({
              action: 'tool_result',
              at: new Date().toISOString(),
              trigger,
              tool: action.name,
              result: this.compactToolResult(toolResult.result),
            });
            actionResults.push(toolResult.result);
            if (toolResult.stop) {
              return {};
            }
          }

          if (actionResults.length > 0) {
            messages.push({
              role: 'tool',
              content: JSON.stringify(actionResults),
            });
          }

          const publicResponse = jsonResult.response.trim();
          if (publicResponse) {
            await this.appendChatState({
              action: 'respond',
              at: new Date().toISOString(),
              trigger,
              response: publicResponse,
            });
            return { response: publicResponse };
          }

          if (jsonResult.no_response || this.pendingMessages.length === 0) {
            await this.appendChatState({
              action: 'no_response',
              at: new Date().toISOString(),
              trigger,
            });
            return {};
          }

          if (this.pendingMessages.length > 0) {
            continue;
          }

          continue;
        }

        await this.appendChatState({
          action: 'tool_call',
          at: new Date().toISOString(),
          trigger,
          tool: toolCall.function.name,
          arguments: toolCall.function.arguments,
        });
        const toolResult = await this.handleToolCall(toolCall, executeAction);
        await this.appendChatState({
          action: 'tool_result',
          at: new Date().toISOString(),
          trigger,
          tool: toolCall.function.name,
          result: this.compactToolResult(toolResult.result),
        });
        if (toolResult.stop) {
          return {};
        }

        messages.push({
          role: 'tool',
          content: JSON.stringify(toolResult.result),
        });
      }

      await this.appendChatState({
        action: 'no_response',
        at: new Date().toISOString(),
        trigger,
        result: { reason: 'max_steps_reached' },
      });
      return {};
    } finally {
      this.isThinking = false;
    }
  }

  private async buildMessages(
    chat: Message[],
    trigger: string,
    emojis?: Emoji[],
    members?: GuildMember[],
  ): Promise<OllamaMessage[]> {
    const [systemPrompt, chatState] = await Promise.all([
      this.readSystemPrompt(),
      this.readChatState(),
    ]);
    const relevantMemories = await this.findRelevantMemories(chat);

    return [
      {
        role: 'system',
        content: buildSystemPrompt(
          systemPrompt,
          emojis?.map((e) => `<:${e.name}:${e.id}>`).join('\n'),
          members?.map((m) => `${m.displayName} <@${m.id}>`).join('\n'),
        ),
      },
      {
        role: 'user',
        content: JSON.stringify({
          trigger,
          relevant_memories: relevantMemories,
          chat_state: chatState.slice(-Number(process.env.CHAT_STATE_PROMPT_LIMIT ?? 40)),
          messages: chat.map((message) => this.serializeMessage(message)),
        }),
      },
    ];
  }

  private async findRelevantMemories(chat: Message[]) {
    const query = this.memoryQuery(chat);
    if (!query) {
      return [];
    }

    try {
      return await this.memory.search(query, Number(process.env.RELEVANT_MEMORY_LIMIT ?? 6));
    } catch (error) {
      console.warn(
        'Failed to prefetch relevant memories:',
        error instanceof Error ? error.message : error,
      );
      return [];
    }
  }

  private memoryQuery(chat: Message[]): string {
    const botId = process.env.BOT_ID;
    return chat
      .filter((message) => message.author.id !== botId && message.content.trim())
      .slice(-4)
      .map((message) => `${message.author.displayName} ${message.content}`)
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
  }

  private insertPendingMessages(messages: OllamaMessage[]): void {
    if (this.pendingMessages.length === 0) {
      return;
    }

    const pending = this.pendingMessages.splice(0);
    console.log(`Inserted ${pending.length} pending message(s) into Ollama chat`);
    messages.push({
      role: 'user',
      content: JSON.stringify({
        type: 'new_messages_while_thinking',
        messages: pending.map((message) => this.serializeMessage(message)),
      }),
    });
  }

  private async chatWithTimeout(messages: OllamaMessage[]) {
    try {
      return await ollama.chat({
        model: process.env.OLLAMA_MODEL ?? 'gemma4:e4b',
        messages,
        tools,
        think: this.ollamaThink(),
        options: {
          num_ctx: Number(process.env.OLLAMA_NUM_CTX ?? 8192),
          num_predict: Number(process.env.OLLAMA_NUM_PREDICT ?? 800),
          embedding_only: false,
        },
        format: aiResponseFormat,
      });
    } catch (error) {
      console.error('Ollama chat error:', error);
      throw error;
    }
  }

  private serializeMessage(message: Message, maxContentLength?: number) {
    const content =
      maxContentLength && message.content.length > maxContentLength
        ? `${message.content.slice(0, maxContentLength)}...`
        : message.content;

    return {
      id: message.id,
      role: message.author.id === process.env.BOT_ID ? 'assistant' : 'user',
      author: {
        id: message.author.id,
        displayName: message.author.displayName,
        isBot: message.author.bot,
      },
      content,
      reactions: message.reactions.cache.map((reaction) => ({
        emoji: reaction.emoji.id
          ? `<:${reaction.emoji.name ?? 'emoji'}:${reaction.emoji.id}>`
          : (reaction.emoji.name ?? ''),
        count: reaction.count,
        me: reaction.me,
      })),
      createdAt: message.createdAt.toISOString(),
    };
  }

  private async readSystemPrompt(): Promise<string> {
    if (this.systemPromptCache !== undefined) {
      return this.systemPromptCache;
    }

    try {
      const prompt = await readFile(this.systemPromptPath, 'utf8');
      this.systemPromptCache = prompt;
      console.log(`Loaded system prompt from ${this.systemPromptPath}`);
      return prompt;
    } catch {
      await this.writeSystemPrompt(DEFAULT_SYSTEM_PROMPT);
      console.log(`Created system prompt at ${this.systemPromptPath}`);
      return DEFAULT_SYSTEM_PROMPT;
    }
  }

  private async writeSystemPrompt(markdown: string): Promise<void> {
    const prompt = `${markdown.trim()}\n`;
    this.systemPromptCache = prompt;
    await mkdir(dirname(this.systemPromptPath), { recursive: true });
    await writeFile(this.systemPromptPath, prompt, 'utf8');
  }

  private async readChatState(): Promise<ChatStateEntry[]> {
    if (this.chatStateCache) {
      return this.chatStateCache;
    }

    try {
      const parsed = JSON.parse(await readFile(this.chatStatePath, 'utf8')) as unknown;
      this.chatStateCache = Array.isArray(parsed) ? (parsed as ChatStateEntry[]) : [];
      return this.chatStateCache;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
        console.warn(`Failed to read chat state from ${this.chatStatePath}:`, error.message);
      }

      this.chatStateCache = [];
      return this.chatStateCache;
    }
  }

  private async appendChatState(entry: ChatStateEntry): Promise<void> {
    try {
      const limit = Number(process.env.CHAT_STATE_LIMIT ?? 80);
      const state = [...(await this.readChatState()), entry].slice(-limit);
      this.chatStateCache = state;
      await mkdir(dirname(this.chatStatePath), { recursive: true });
      await writeFile(this.chatStatePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    } catch (error) {
      console.error('Failed to update chat state', error);
    }
  }

  private compactToolResult(result: unknown): unknown {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return result;
    }

    const value = result as Record<string, unknown>;
    if (value.tool === 'memory_search' && Array.isArray(value.memories)) {
      return {
        tool: value.tool,
        ok: value.ok,
        count: value.memories.length,
        ids: value.memories
          .map((memory) =>
            memory && typeof memory === 'object' && 'id' in memory
              ? (memory as { id: unknown }).id
              : undefined,
          )
          .filter(Boolean),
      };
    }

    if (value.tool === 'memory_recent' && Array.isArray(value.memories)) {
      return {
        tool: value.tool,
        ok: value.ok,
        count: value.memories.length,
      };
    }

    return result;
  }

  private async handleToolCall(
    call: ToolCall,
    executeAction?: (action: DiscordAction) => Promise<unknown>,
  ): Promise<{ stop: boolean; result: unknown }> {
    return await this.handleToolAction(call.function.name, call.function.arguments, executeAction);
  }

  private async handleToolAction(
    name: string,
    args: Record<string, unknown>,
    executeAction?: (action: DiscordAction) => Promise<unknown>,
  ): Promise<{ stop: boolean; result: unknown }> {
    console.log(`Tool call: ${name}`, args);

    try {
      switch (name) {
        case 'reply_to_message':
          if (this.hasExactArgs(args, ['message_id', 'content'])) {
            const messageId = this.stringArg(args, 'message_id');
            const content = this.stringArg(args, 'content');
            if (!messageId || !content) {
              break;
            }

            await executeAction?.({
              type: 'reply_to_message',
              messageId,
              content,
            });
            return { stop: false, result: { tool: 'reply_to_message', ok: true } };
          }
          break;
        case 'add_reaction':
          if (this.hasExactArgs(args, ['message_id', 'emoji'])) {
            const messageId = this.stringArg(args, 'message_id');
            const emoji = this.stringArg(args, 'emoji');
            if (!messageId || !emoji) {
              break;
            }

            await executeAction?.({
              type: 'add_reaction',
              messageId,
              emoji,
            });
            return { stop: false, result: { tool: 'add_reaction', ok: true } };
          }
          break;
        case 'change_nickname':
          if (this.hasExactArgs(args, ['nickname'])) {
            const nickname = this.stringArg(args, 'nickname');
            if (!nickname) {
              break;
            }

            await executeAction?.({ type: 'change_nickname', nickname });
            return { stop: false, result: { tool: 'change_nickname', ok: true } };
          }
          break;
        case 'update_system_prompt':
          if (this.hasExactArgs(args, ['markdown'])) {
            const markdown = this.stringArg(args, 'markdown');
            if (!markdown) {
              break;
            }

            await this.writeSystemPrompt(markdown);
            console.log(`Updated system prompt at ${this.systemPromptPath}`);
            return {
              stop: false,
              result: { tool: 'update_system_prompt', ok: true, path: this.systemPromptPath },
            };
          }
          break;
        case 'memory_search':
          if (this.hasExactArgs(args, ['query'], ['limit'])) {
            const query = this.stringArg(args, 'query');
            if (!query || (args.limit !== undefined && typeof args.limit !== 'number')) {
              break;
            }

            const limit =
              typeof args.limit === 'number'
                ? Math.min(10, Math.max(1, Math.floor(args.limit)))
                : 5;
            return {
              stop: false,
              result: {
                tool: 'memory_search',
                ok: true,
                memories: await this.memory.search(query, limit),
              },
            };
          }
          break;
        case 'memory_store':
          if (this.hasExactArgs(args, ['text'])) {
            const text = this.stringArg(args, 'text');
            if (!text) {
              break;
            }

            return {
              stop: false,
              result: { tool: 'memory_store', ok: true, id: await this.memory.store(text) },
            };
          }
          break;
        case 'memory_update':
          if (this.hasExactArgs(args, ['id', 'text'])) {
            const id = this.stringArg(args, 'id');
            const text = this.stringArg(args, 'text');
            if (!id || !text) {
              break;
            }

            return {
              stop: false,
              result: {
                tool: 'memory_update',
                ok: true,
                id: await this.memory.update(id, text),
              },
            };
          }
          break;
        case 'memory_delete':
          if (this.hasExactArgs(args, ['id'])) {
            const id = this.stringArg(args, 'id');
            if (!id) {
              break;
            }

            return {
              stop: false,
              result: { tool: 'memory_delete', ok: true, id: await this.memory.delete(id) },
            };
          }
          break;
        case 'memory_recent':
          if (this.hasExactArgs(args, [], ['limit'])) {
            if (args.limit !== undefined && typeof args.limit !== 'number') {
              break;
            }

            const limit =
              typeof args.limit === 'number'
                ? Math.min(20, Math.max(1, Math.floor(args.limit)))
                : 10;
            return {
              stop: false,
              result: {
                tool: 'memory_recent',
                ok: true,
                memories: await this.memory.recent(limit),
              },
            };
          }
          break;
        case 'no_response':
          console.log('Tool result: no_response ok');
          return { stop: true, result: { tool: 'no_response', ok: true } };
      }

      console.warn(`Tool result: ${name} invalid args`, args);
      return {
        stop: false,
        result: {
          tool: name,
          ok: false,
          error: 'Invalid tool arguments. Use the exact schema for this tool and no extra keys.',
        },
      };
    } catch (error) {
      console.error(`Tool result: ${name} failed`, error);
      return {
        stop: false,
        result: {
          tool: name,
          ok: false,
          error: error instanceof Error ? error.message : 'Tool failed',
        },
      };
    }
  }

  private parseJsonResult(content: string): JsonAiResult | undefined {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (
        !this.isRecord(parsed) ||
        !this.hasExactArgs(parsed, ['actions', 'response', 'no_response']) ||
        !Array.isArray(parsed.actions) ||
        typeof parsed.response !== 'string' ||
        typeof parsed.no_response !== 'boolean'
      ) {
        return undefined;
      }

      const actions = parsed.actions.map((action) => this.parseJsonAction(action));
      if (actions.some((action) => !action)) {
        return undefined;
      }

      return {
        actions: actions as JsonAction[],
        response: parsed.response,
        no_response: parsed.no_response,
      };
    } catch {
      return undefined;
    }
  }

  private parseJsonAction(action: unknown): JsonAction | undefined {
    if (
      !this.isRecord(action) ||
      !this.hasExactArgs(action, ['name', 'arguments']) ||
      typeof action.name !== 'string' ||
      !this.isRecord(action.arguments)
    ) {
      return undefined;
    }

    const args = action.arguments;
    switch (action.name) {
      case 'no_response':
        return this.hasExactArgs(args, []) ? { name: action.name, arguments: {} } : undefined;
      case 'reply_to_message':
        return this.hasExactArgs(args, ['message_id', 'content']) &&
          this.nonEmptyString(args.message_id) &&
          this.nonEmptyString(args.content)
          ? {
              name: action.name,
              arguments: { message_id: args.message_id, content: args.content },
            }
          : undefined;
      case 'add_reaction':
        return this.hasExactArgs(args, ['message_id', 'emoji']) &&
          this.nonEmptyString(args.message_id) &&
          this.nonEmptyString(args.emoji)
          ? { name: action.name, arguments: { message_id: args.message_id, emoji: args.emoji } }
          : undefined;
      case 'change_nickname':
        return this.hasExactArgs(args, ['nickname']) && this.nonEmptyString(args.nickname)
          ? { name: action.name, arguments: { nickname: args.nickname } }
          : undefined;
      case 'update_system_prompt':
        return this.hasExactArgs(args, ['markdown']) && this.nonEmptyString(args.markdown)
          ? { name: action.name, arguments: { markdown: args.markdown } }
          : undefined;
      case 'memory_search':
        return this.hasExactArgs(args, ['query'], ['limit']) &&
          this.nonEmptyString(args.query) &&
          this.optionalIntInRange(args.limit, 1, 10)
          ? {
              name: action.name,
              arguments: {
                query: args.query,
                ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
              },
            }
          : undefined;
      case 'memory_store':
        return this.hasExactArgs(args, ['text']) && this.nonEmptyString(args.text)
          ? { name: action.name, arguments: { text: args.text } }
          : undefined;
      case 'memory_update':
        return this.hasExactArgs(args, ['id', 'text']) &&
          this.nonEmptyString(args.id) &&
          this.nonEmptyString(args.text)
          ? { name: action.name, arguments: { id: args.id, text: args.text } }
          : undefined;
      case 'memory_delete':
        return this.hasExactArgs(args, ['id']) && this.nonEmptyString(args.id)
          ? { name: action.name, arguments: { id: args.id } }
          : undefined;
      case 'memory_recent':
        return this.hasExactArgs(args, [], ['limit']) && this.optionalIntInRange(args.limit, 1, 20)
          ? {
              name: action.name,
              arguments: {
                ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
              },
            }
          : undefined;
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  private nonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
  }

  private optionalIntInRange(value: unknown, min: number, max: number): boolean {
    return (
      value === undefined ||
      (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max)
    );
  }

  private hasExactArgs(args: Record<string, unknown>, required: string[], optional: string[] = []) {
    const allowed = new Set([...required, ...optional]);
    const keys = Object.keys(args);

    return keys.every((key) => allowed.has(key)) && required.every((key) => key in args);
  }

  private stringArg(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
  }

  private ollamaThink(): false | 'low' | 'medium' | 'high' {
    const value = process.env.OLLAMA_THINK;
    if (value === 'false') {
      return false;
    }

    return value === 'low' || value === 'medium' || value === 'high' ? value : 'low';
  }
}
