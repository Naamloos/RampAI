import { watchFile } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Emoji, GuildMember, Message } from 'discord.js';
import type { Message as OllamaMessage, ToolCall } from 'ollama';
import ollama from 'ollama';
import { buildSystemPrompt } from '../constants/system.js';
import ElasticsearchMemoryStore from '../memory/elasticsearch-memory.store.js';
import { tools } from './tools.js';
import type { AiResult, DiscordAction } from './tools.js';
const DEFAULT_SYSTEM_PROMPT = `# Custom Instructions
No custom identity has been defined yet.
`;
interface ChatStateEntry {
  action:
  | 'run_start'
  | 'processed_message'
  | 'discord_message'
  | 'respond'
  | 'no_response'
  | 'tool_call'
  | 'tool_result';
  at: string;
  trigger?: string;
  response?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  messages?: unknown[];
  result?: unknown;
}
export default class OllamaService {
  private static instance: OllamaService;
  private readonly memory = new ElasticsearchMemoryStore();
  private readonly pendingMessages: Message[] = [];
  private readonly recentDiscordActions = new Map<string, number>();
  private readonly systemPromptPath = process.env.SYSTEM_PROMPT_PATH ?? 'system-prompt.md';
  private readonly chatStatePath = process.env.CHAT_STATE_PATH ?? 'chat-state.json';
  private chatStateCache?: ChatStateEntry[];
  private systemPromptCache?: string;
  private chatStateWrite: Promise<void> = Promise.resolve();
  private isThinking = false;
  private constructor() {
    watchFile(this.systemPromptPath, { interval: 500, persistent: false }, (current, previous) => {
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) {
        delete this.systemPromptCache;
        console.log(`System prompt changed; reloading ${this.systemPromptPath} on next turn`);
      }
    });
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
      if (
        entry.action !== 'processed_message' ||
        !entry.result ||
        typeof entry.result !== 'object'
      ) {
        return false;
      }
      return (entry.result as { latestMessageId?: unknown }).latestMessageId === messageId;
    });
  }
  public async recordProcessedMessage(messageId: string, trigger: string): Promise<void> {
    await this.appendChatState({
      action: 'processed_message',
      at: new Date().toISOString(),
      trigger,
      result: { latestMessageId: messageId },
    });
  }
  public async isReflectionDue(): Promise<boolean> {
    const interval = Number(process.env.PERSONALITY_REFLECTION_INTERVAL_MS ?? 21600000);
    if (!Number.isFinite(interval) || interval <= 0) {
      return false;
    }
    const previous = (await this.readChatState())
      .slice()
      .reverse()
      .find((entry) => entry.action === 'run_start' && entry.trigger === 'reflection_tick');
    return !previous || Date.now() - Date.parse(previous.at) >= interval;
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
    activity?: string,
    allowPublicResponse = true,
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
      const messages = await this.buildMessages(
        chat,
        emojis,
        members,
        trigger,
        activity,
        allowPublicResponse,
      );
      const completedToolCalls = new Set<string>();
      let canRespond = allowPublicResponse;
      let latestMessageId = chat.at(-1)?.id;
      const configuredToolSteps = Number(process.env.MAX_TOOL_STEPS ?? 8);
      const maxToolSteps = Number.isInteger(configuredToolSteps)
        ? Math.min(20, Math.max(1, configuredToolSteps))
        : 8;
      for (let i = 0; i < maxToolSteps;) {
        const pendingMessageId = await this.insertPendingMessages(messages);
        if (pendingMessageId) {
          latestMessageId = pendingMessageId;
          canRespond = true;
          messages.push({
            role: 'system',
            content:
              'New human messages arrived. End silent reflection and respond normally if useful.',
          });
        }
        const response = await this.chatWithTimeout(messages);
        const rawContent = response.message.content;
        response.message.content = response.message.content.replace(
          /^\s*<(think(?:ing)?)>[\s\S]*?<\/\1>\s*/i,
          '',
        );
        if (response.message.content !== rawContent) {
          console.log('Removed private thinking markup from Ollama output');
        }
        if (this.pendingMessages.length > 0) {
          console.log('Discarding stale Ollama output because newer messages arrived');
          continue;
        }
        i += 1;
        const toolCalls = response.message.tool_calls ?? [];
        if (toolCalls.length === 0) {
          const textToolCall = this.parseTextToolCall(response.message.content);
          if (textToolCall) {
            console.warn('Recovered textual Ollama tool call');
            response.message.content = '';
            toolCalls.push(textToolCall);
            response.message.tool_calls = toolCalls;
          } else if (this.hasTextToolCallMarkup(response.message.content)) {
            console.warn('Discarding malformed textual Ollama tool call');
            response.message.content = '';
          }
        }
        messages.push(response.message);
        if (toolCalls.length === 0) {
          const publicResponse = canRespond
            ? this.sanitizePublicResponse(response.message.content)
            : '';
          if (publicResponse) {
            await this.appendChatState({
              action: 'respond',
              at: new Date().toISOString(),
              trigger,
              response: publicResponse,
            });
            return {
              response: publicResponse,
              ...(latestMessageId ? { latestMessageId } : {}),
            };
          }
          await this.appendChatState({
            action: 'no_response',
            at: new Date().toISOString(),
            trigger,
          });
          return latestMessageId ? { latestMessageId } : {};
        }
        for (const toolCall of toolCalls) {
          const signature = JSON.stringify([toolCall.function.name, toolCall.function.arguments]);
          const toolResult = completedToolCalls.has(signature)
            ? {
              stop: false,
              result: {
                tool: toolCall.function.name,
                ok: false,
                error: 'This exact tool call already completed. Do not repeat it.',
              },
            }
            : await this.handleLoggedToolCall(
              toolCall,
              trigger,
              canRespond ? executeAction : undefined,
            );
          completedToolCalls.add(signature);
          if (toolResult.stop) {
            return latestMessageId ? { latestMessageId } : {};
          }
          messages.push({
            role: 'tool',
            tool_name: toolCall.function.name,
            content: JSON.stringify(toolResult.result),
          });
        }
      }
      await this.appendChatState({
        action: 'no_response',
        at: new Date().toISOString(),
        trigger,
        result: { reason: 'max_steps_reached' },
      });
      return latestMessageId ? { latestMessageId } : {};
    } finally {
      this.isThinking = false;
    }
  }
  private async buildMessages(
    chat: Message[],
    emojis?: Emoji[],
    members?: GuildMember[],
    trigger = 'message',
    activity?: string,
    allowPublicResponse = true,
  ): Promise<OllamaMessage[]> {
    const [systemPrompt, relevantMemories] = await Promise.all([
      this.readSystemPrompt(),
      this.findRelevantMemories(chat),
    ]);
    return [
      {
        role: 'system',
        content: buildSystemPrompt(
          systemPrompt,
          emojis
            ?.filter((emoji) => emoji.id)
            .map(
              (emoji) =>
                `<${emoji.animated ? 'a' : ''}:${emoji.name ?? 'emoji'}:${emoji.id}>`,
            )
            .join('\n'),
          JSON.stringify(
            members?.map((member) => ({
              username: member.user.username,
              nickname: member.nickname,
              id: member.id,
            })) ?? [],
          ),
          this.recentParticipants(chat),
          `trigger=${trigger}; public_response_allowed=${allowPublicResponse}; clanker_trigger=${trigger !== 'reflection_tick' && this.hasClankerTrigger(chat)}${activity ? `; event=${activity}` : ''}`,
          relevantMemories.map((memory) => `[${memory.id}] ${memory.text}`).join('\n'),
        ),
      },
      ...(await Promise.all(chat.map((message) => this.toOllamaMessageWithAttachments(message)))),
    ];
  }
  private recentParticipants(chat: Message[]): string {
    const participants = new Map<
      string,
      { username: string; nickname: string | null; id: string }
    >();
    for (const message of chat) {
      if (message.author.id !== process.env.BOT_ID) {
        participants.set(message.author.id, {
          username: message.author.username,
          nickname: message.member?.nickname ?? null,
          id: message.author.id,
        });
      }
    }
    return JSON.stringify([...participants.values()]);
  }
  private hasClankerTrigger(chat: Message[]): boolean {
    const latestHumanMessage = chat.findLast((message) => !message.author.bot);
    return Boolean(latestHumanMessage && /\bclanker\b/i.test(latestHumanMessage.content));
  }
  private async findRelevantMemories(chat: Message[]) {
    const query = chat
      .filter((message) => message.author.id !== process.env.BOT_ID && message.content.trim())
      .slice(-5)
      .map((message) => `${message.author.displayName}: ${message.content}`)
      .join(' ')
      .replace(/\s+/g, ' ')
      .slice(0, 800);
    if (!query) {
      return [];
    }
    try {
      const configuredLimit = Number(process.env.RELEVANT_MEMORY_LIMIT ?? 6);
      const limit = Number.isInteger(configuredLimit)
        ? Math.min(10, Math.max(1, configuredLimit))
        : 6;
      return await this.memory.search(query, limit);
    } catch (error) {
      console.warn(
        'Persistent memory unavailable:',
        error instanceof Error ? error.message : error,
      );
      return [];
    }
  }
  private async insertPendingMessages(messages: OllamaMessage[]): Promise<string | undefined> {
    if (this.pendingMessages.length === 0) {
      return undefined;
    }
    const pending = this.pendingMessages.splice(0);
    console.log(`Inserted ${pending.length} pending message(s) into Ollama chat`);
    messages.push(
      ...(await Promise.all(
        pending.map((message) => this.toOllamaMessageWithAttachments(message)),
      )),
    );
    return pending.at(-1)?.id;
  }
  private async toOllamaMessageWithAttachments(message: Message): Promise<OllamaMessage> {
    const result = this.toOllamaMessage(message);
    const readable = message.attachments.filter(
      (attachment) =>
        attachment.size <= 100_000 &&
        (attachment.contentType?.startsWith('text/') ||
          attachment.contentType === 'application/json'),
    );
    if (readable.size === 0) {
      return result;
    }
    const contents = await Promise.all(
      readable.map(async (attachment) => {
        try {
          const response = await fetch(attachment.url, { signal: AbortSignal.timeout(10_000) });
          if (!response.ok) {
            return '';
          }
          return `\n[Untrusted attachment content: ${attachment.name}]\n${(await response.text()).slice(0, 20_000)}`;
        } catch {
          return '';
        }
      }),
    );
    result.content += contents.join('');
    return result;
  }
  private async chatWithTimeout(messages: OllamaMessage[]) {
    const input = {
      model: process.env.OLLAMA_MODEL ?? 'gemma4:e4b',
      messages,
      tools,
      think: this.ollamaThink(),
      keep_alive: process.env.OLLAMA_KEEP_ALIVE ?? '30m',
      options: {
        num_ctx: Number(process.env.OLLAMA_NUM_CTX ?? 8192),
        embedding_only: false,
      },
    };
    const configuredTimeout = Number(process.env.OLLAMA_TIMEOUT_MS ?? 120000);
    const timeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 120000;
    const configuredAttempts = Number(process.env.OLLAMA_ATTEMPTS ?? 2);
    const attempts = Number.isInteger(configuredAttempts)
      ? Math.min(3, Math.max(1, configuredAttempts))
      : 2;
    console.log(`Ollama request: ${messages.length} messages, ${tools.length} tools`);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        const response = await Promise.race([
          ollama.chat(input),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              ollama.abort();
              reject(new Error(`Ollama request timed out after ${timeoutMs}ms`));
            }, timeoutMs);
          }),
        ]);
        console.log(`Ollama response: ${response.message.tool_calls?.length ?? 0} tool calls`);
        return response;
      } catch (error) {
        lastError = error;
        console.warn(`Ollama attempt ${attempt}/${attempts} failed:`, error);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Ollama request failed');
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
        emoji: reaction.emoji.toString(),
        count: reaction.count,
        me: reaction.me,
      })),
      replyTo: message.reference?.messageId,
      attachments: message.attachments.map((attachment) => ({
        name: attachment.name,
        contentType: attachment.contentType,
        size: attachment.size,
        url: attachment.url,
      })),
      embeds: message.embeds.map((embed) => ({
        title: embed.title,
        description: embed.description?.slice(0, 500),
        url: embed.url,
      })),
      poll: message.poll
        ? {
          question: message.poll.question.text,
          answers: message.poll.answers.map((answer) => answer.text),
        }
        : undefined,
      createdAt: message.createdAt.toISOString(),
    };
  }
  private toOllamaMessage(message: Message): OllamaMessage {
    const reactions = message.reactions.cache
      .map((reaction) => {
        const emoji = reaction.emoji.toString();
        return `${emoji}×${reaction.count}`;
      })
      .join(', ');
    const metadata = [
      `Discord message ${message.id}`,
      `${message.author.displayName} <@${message.author.id}>`,
      ...(message.reference?.messageId ? [`reply to ${message.reference.messageId}`] : []),
      ...(reactions ? [`reactions: ${reactions}`] : []),
      ...message.attachments.map(
        (attachment) =>
          `attachment: ${attachment.name} (${attachment.contentType ?? 'unknown'}, ${attachment.size} bytes) ${attachment.url}`,
      ),
      ...message.embeds.map(
        (embed) =>
          `embed: ${[embed.title, embed.description?.slice(0, 300), embed.url].filter(Boolean).join(' — ')}`,
      ),
      ...(message.poll
        ? [
          `poll: ${message.poll.question.text}; answers: ${message.poll.answers
            .map((answer) => answer.text)
            .join(', ')}`,
        ]
        : []),
    ].join(' | ');
    return {
      role: message.author.id === process.env.BOT_ID ? 'assistant' : 'user',
      content: `[${metadata}]\n${message.content}`,
    };
  }
  private async readSystemPrompt(): Promise<string> {
    if (this.systemPromptCache !== undefined) {
      return this.systemPromptCache;
    }
    try {
      const prompt = await readFile(this.systemPromptPath, 'utf8');
      if (prompt.trim().length < 20 || prompt.length > 12_000) {
        throw new Error('System prompt has an invalid length.');
      }
      this.systemPromptCache = prompt;
      console.log(`Loaded system prompt from ${this.systemPromptPath}`);
      return prompt;
    } catch (error) {
      const history = await this.readPromptHistory();
      const recovered = history.at(-1);
      if (recovered) {
        this.systemPromptCache = recovered;
        console.warn(`Recovered system prompt from ${this.systemPromptPath}.history.json`);
        return recovered;
      }
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        await this.writeSystemPrompt(DEFAULT_SYSTEM_PROMPT);
        console.log(`Created system prompt at ${this.systemPromptPath}`);
        return DEFAULT_SYSTEM_PROMPT;
      }
      console.warn(`Failed to read system prompt at ${this.systemPromptPath}; using default.`);
      return DEFAULT_SYSTEM_PROMPT;
    }
  }
  private async writeSystemPrompt(markdown: string): Promise<void> {
    const prompt = `${markdown.trim()}\n`;
    if (prompt.length < 20 || prompt.length > 12_000) {
      throw new Error('System prompt must be between 20 and 12000 characters.');
    }
    const previous =
      this.systemPromptCache ?? (await readFile(this.systemPromptPath, 'utf8').catch(() => ''));
    await mkdir(dirname(this.systemPromptPath), { recursive: true });
    await writeFile(this.systemPromptPath, prompt, 'utf8');
    this.systemPromptCache = prompt;
    if (previous.trim() && previous !== prompt) {
      const history = [...(await this.readPromptHistory()), previous].slice(-10);
      await writeFile(
        `${this.systemPromptPath}.history.json`,
        `${JSON.stringify(history, null, 2)}\n`,
        'utf8',
      );
    }
  }
  private async readPromptHistory(): Promise<string[]> {
    try {
      const value = JSON.parse(
        await readFile(`${this.systemPromptPath}.history.json`, 'utf8'),
      ) as unknown;
      return Array.isArray(value)
        ? value.filter(
          (item): item is string =>
            typeof item === 'string' && item.trim().length >= 20 && item.length <= 12_000,
        )
        : [];
    } catch {
      return [];
    }
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
    const write = this.chatStateWrite.then(async () => {
      try {
        const configuredLimit = Number(process.env.CHAT_STATE_LIMIT ?? 80);
        const limit = Number.isInteger(configuredLimit) ? Math.max(20, configuredLimit) : 80;
        const state = [...(await this.readChatState()), entry].slice(-limit);
        this.chatStateCache = state;
        await mkdir(dirname(this.chatStatePath), { recursive: true });
        await writeFile(this.chatStatePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      } catch (error) {
        console.error('Failed to update chat state', error);
      }
    });
    this.chatStateWrite = write;
    await write;
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
  private compactToolArguments(
    name: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (name === 'update_system_prompt') {
      return { markdownLength: typeof args.markdown === 'string' ? args.markdown.length : 0 };
    }
    if (name.startsWith('memory_') && typeof args.text === 'string') {
      return { ...args, text: `${args.text.slice(0, 200)}${args.text.length > 200 ? '…' : ''}` };
    }
    return args;
  }
  private async handleToolCall(
    call: ToolCall,
    executeAction?: (action: DiscordAction) => Promise<unknown>,
  ): Promise<{ stop: boolean; result: unknown }> {
    return await this.handleToolAction(call.function.name, call.function.arguments, executeAction);
  }
  private async handleLoggedToolCall(
    call: ToolCall,
    trigger: string,
    executeAction?: (action: DiscordAction) => Promise<unknown>,
  ): Promise<{ stop: boolean; result: unknown }> {
    await this.appendChatState({
      action: 'tool_call',
      at: new Date().toISOString(),
      trigger,
      tool: call.function.name,
      arguments: this.compactToolArguments(call.function.name, call.function.arguments),
    });
    const toolResult = await this.handleToolCall(call, executeAction);
    await this.appendChatState({
      action: 'tool_result',
      at: new Date().toISOString(),
      trigger,
      tool: call.function.name,
      result: this.compactToolResult(toolResult.result),
    });
    return toolResult;
  }
  private async handleToolAction(
    name: string,
    args: Record<string, unknown>,
    executeAction?: (action: DiscordAction) => Promise<unknown>,
  ): Promise<{ stop: boolean; result: unknown }> {
    console.log(`Tool call: ${name}`);
    try {
      switch (name) {
        case 'reply_to_message':
        case 'edit_message':
          if (this.hasExactArgs(args, ['message_id', 'content'])) {
            const messageId = this.stringArg(args, 'message_id');
            const content = this.stringArg(args, 'content');
            if (!messageId || !content) {
              break;
            }
            return await this.runDiscordAction(executeAction, { type: name, messageId, content });
          }
          break;
        case 'add_reaction':
        case 'remove_reaction':
          if (this.hasExactArgs(args, ['message_id', 'emoji'])) {
            const messageId = this.stringArg(args, 'message_id');
            const emoji = this.stringArg(args, 'emoji');
            if (!messageId || !emoji) {
              break;
            }
            return await this.runDiscordAction(executeAction, { type: name, messageId, emoji });
          }
          break;
        case 'delete_message':
        case 'pin_message':
        case 'unpin_message':
          if (this.hasExactArgs(args, ['message_id'])) {
            const messageId = this.stringArg(args, 'message_id');
            if (!messageId) {
              break;
            }
            return await this.runDiscordAction(executeAction, { type: name, messageId });
          }
          break;
        case 'change_nickname':
          if (this.hasExactArgs(args, ['nickname'])) {
            const nickname = this.stringArg(args, 'nickname');
            if (!nickname || nickname.length > 32) {
              break;
            }
            return await this.runDiscordAction(executeAction, { type: name, nickname });
          }
          break;
        case 'get_member_presence':
          if (this.hasExactArgs(args, ['member'])) {
            const member = this.stringArg(args, 'member');
            if (!member || member.length > 100) {
              break;
            }
            return await this.runDiscordAction(executeAction, { type: name, member });
          }
          break;
        case 'create_poll':
          if (this.hasExactArgs(args, ['question', 'answers'], ['duration_hours'])) {
            const question = this.stringArg(args, 'question');
            const answers = Array.isArray(args.answers)
              ? args.answers.filter(
                (answer): answer is string => typeof answer === 'string' && !!answer.trim(),
              )
              : [];
            const durationHours = this.integerArg(args, 'duration_hours', 1, 168, 24);
            if (
              !question ||
              question.length > 300 ||
              !Number.isFinite(durationHours) ||
              answers.length < 2 ||
              answers.length > 10 ||
              answers.some((answer) => answer.length > 55)
            ) {
              break;
            }
            return await this.runDiscordAction(executeAction, {
              type: 'create_poll',
              question,
              answers,
              durationHours,
            });
          }
          break;
        case 'search_channel_history':
          if (this.hasExactArgs(args, ['query'], ['limit'])) {
            const query = this.stringArg(args, 'query');
            if (!query) {
              break;
            }
            return await this.runDiscordAction(executeAction, {
              type: 'search_channel_history',
              query,
              limit: this.integerArg(args, 'limit', 1, 20, 10),
            });
          }
          break;
        case 'schedule_message':
          if (this.hasExactArgs(args, ['content', 'delay_minutes'])) {
            const content = this.stringArg(args, 'content');
            const delayMinutes = this.integerArg(args, 'delay_minutes', 1, 43200);
            if (!content || !Number.isFinite(delayMinutes)) {
              break;
            }
            return await this.runDiscordAction(executeAction, {
              type: 'schedule_message',
              content,
              delayMinutes,
            });
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
            const limit = this.integerArg(args, 'limit', 1, 10, 5);
            if (!query || query.length > 800 || !Number.isFinite(limit)) {
              break;
            }
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
            if (!text || text.length > 2000) {
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
            if (!id || !text || text.length > 2000) {
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
            const limit = this.integerArg(args, 'limit', 1, 20, 10);
            if (!Number.isFinite(limit)) {
              break;
            }
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
  private hasExactArgs(args: Record<string, unknown>, required: string[], optional: string[] = []) {
    const allowed = new Set([...required, ...optional]);
    const keys = Object.keys(args);
    return keys.every((key) => allowed.has(key)) && required.every((key) => key in args);
  }
  private stringArg(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
  }
  private integerArg(
    args: Record<string, unknown>,
    key: string,
    min: number,
    max: number,
    fallback = Number.NaN,
  ): number {
    const value = args[key];
    if (value === undefined) {
      return fallback;
    }
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
      ? value
      : Number.NaN;
  }
  private async runDiscordAction(
    executeAction: ((action: DiscordAction) => Promise<unknown>) | undefined,
    action: DiscordAction,
  ): Promise<{ stop: false; result: unknown }> {
    if (!executeAction) {
      return {
        stop: false,
        result: {
          tool: action.type,
          ok: false,
          error: 'Discord actions are unavailable during silent reflection.',
        },
      };
    }
    const signature = JSON.stringify(action);
    const shouldCooldown =
      action.type !== 'search_channel_history' && action.type !== 'get_member_presence';
    const configuredCooldown = Number(process.env.ACTION_COOLDOWN_MS ?? 10000);
    const cooldown = Number.isFinite(configuredCooldown) ? Math.max(0, configuredCooldown) : 10_000;
    const previous = this.recentDiscordActions.get(signature);
    if (shouldCooldown && previous && Date.now() - previous < cooldown) {
      return {
        stop: false,
        result: { tool: action.type, ok: false, error: 'Duplicate action suppressed.' },
      };
    }
    const result = await executeAction(action);
    if (shouldCooldown && (!this.isRecord(result) || result.ok !== false)) {
      this.recentDiscordActions.set(signature, Date.now());
      for (const [key, at] of this.recentDiscordActions) {
        if (Date.now() - at >= cooldown) {
          this.recentDiscordActions.delete(key);
        }
      }
    }
    return { stop: false, result };
  }
  private parseTextToolCall(content: string): ToolCall | undefined {
    const match =
      /^\s*(?:<tool_call>|<\|tool_call>)\s*(?:call:)?([A-Za-z_][A-Za-z0-9_]*)\s*(\{[\s\S]*\})\s*(?:<\/tool_call>|<tool_call\|>)\s*$/.exec(
        content,
      );
    if (!match) {
      return undefined;
    }
    const [, name, rawArguments] = match;
    if (!name || !rawArguments || !tools.some((tool) => tool.function.name === name)) {
      return undefined;
    }
    const args = this.parseTextToolArguments(rawArguments);
    if (!args) {
      return undefined;
    }
    return { function: { name, arguments: args } };
  }
  private hasTextToolCallMarkup(content: string): boolean {
    return content.includes('<tool_call>') || content.includes('<|tool_call>');
  }
  private sanitizePublicResponse(content: string): string {
    return content.replace(/^(?:\s*\[Discord message \d+[^\]\r\n]*\]\s*)+/i, '').trim();
  }
  private isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }
  private parseTextToolArguments(rawArguments: string): Record<string, unknown> | undefined {
    try {
      const parsed = JSON.parse(rawArguments) as unknown;
      return this.isRecord(parsed) ? parsed : undefined;
    } catch {
      const body = rawArguments.slice(1, -1);
      if (!body.trim()) {
        return {};
      }
      const args: Record<string, unknown> = {};
      const argument =
        /\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:<\|"\|>([\s\S]*?)<\|"\|>|(-?\d+(?:\.\d+)?|true|false|null))\s*(?:,|$)/gy;
      while (argument.lastIndex < body.length) {
        const match = argument.exec(body);
        if (!match?.[1]) {
          return undefined;
        }
        args[match[1]] = match[2] ?? JSON.parse(match[3] ?? 'null');
      }
      return args;
    }
  }
  private ollamaThink(): false | 'low' | 'medium' | 'high' {
    const value = process.env.OLLAMA_THINK;
    if (value === 'false') {
      return false;
    }
    return value === 'low' || value === 'medium' || value === 'high' ? value : 'low';
  }
}
