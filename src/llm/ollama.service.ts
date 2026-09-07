import { watchFile } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Emoji, GuildMember, Message } from 'discord.js';
import type { Message as OllamaMessage, ToolCall } from 'ollama';
import ollama from 'ollama';
import { buildSystemPrompt } from '../constants/system.js';
import ElasticsearchMemoryStore from '../memory/elasticsearch-memory.store.js';
import { compactToolArguments, compactToolResult, executeRegisteredTool, tools } from './tools.js';
import type { AiResult, DiscordAction } from './tools.js';
import {
  boundedToolResult,
  ContextBudgetError,
  contextLimits,
  fitContext,
  isContextOverflow,
} from './context-budget.js';
import DiscordImageCache, { discordImageKey, IMAGE_BYTE_LIMIT } from '../discord/image-cache.js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
const DEFAULT_SYSTEM_PROMPT = `# Custom Instructions
No custom identity has been defined yet.
`;
const ATTACHMENT_TEXT_LIMIT = 2000;
const ATTACHMENTS_PER_CONTEXT = 3;
const ATTACHMENT_BYTE_LIMIT = 100_000;
const ATTACHMENT_CACHE_LIMIT = 64;
const ATTACHMENT_CACHE_TTL_MS = 10 * 60_000;
const SEARCH_TIMEOUT_MS = 10_000;
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
  private readonly imageCache = new DiscordImageCache();
  private readonly pendingMessages: Message[] = [];
  private readonly recentDiscordActions = new Map<string, number>();
  private readonly approvedProfileImageUrls = new Set<string>();
  private readonly attachmentCache = new Map<
    string,
    { expiresAt: number; text: Promise<string> }
  >();
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
  public hasPendingMessages(): boolean {
    return this.pendingMessages.length > 0;
  }
  public addIncomingMessage(message: Message): void {
    this.pendingMessages.push(message);
    if (this.pendingMessages.length > 100) this.pendingMessages.shift();
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
    onToolResult?: (name: string, result: unknown, args: Record<string, unknown>) => Promise<void>,
  ): Promise<AiResult | undefined> {
    if (this.isThinking) {
      return undefined;
    }
    this.isThinking = true;
    this.approvedProfileImageUrls.clear();
    const known = new Set(chat.map((message) => message.id));
    for (let index = this.pendingMessages.length - 1; index >= 0; index -= 1) {
      if (known.has(this.pendingMessages[index]!.id)) this.pendingMessages.splice(index, 1);
    }
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
      const attachmentBudget = { remaining: ATTACHMENTS_PER_CONTEXT, imagesRemaining: 2 };
      const messages = await this.buildMessages(
        chat,
        emojis,
        members,
        trigger,
        activity,
        allowPublicResponse,
        attachmentBudget,
      );
      const completedToolCalls = new Set<string>();
      let canRespond = allowPublicResponse;
      let latestMessageId = chat.at(-1)?.id;
      const configuredToolSteps = Number(process.env.MAX_TOOL_STEPS ?? 8);
      const maxToolSteps = Number.isInteger(configuredToolSteps)
        ? Math.min(20, Math.max(1, configuredToolSteps))
        : 8;
      for (let i = 0; i < maxToolSteps;) {
        const pendingMessageId = await this.insertPendingMessages(messages, attachmentBudget);
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
        i += 1;
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
          if (canRespond && onToolResult) {
            try {
              await onToolResult(
                toolCall.function.name,
                toolResult.result,
                toolCall.function.arguments,
              );
            } catch (error) {
              console.warn('Failed to publish tool summary:', error);
            }
          }
          if (toolResult.stop) {
            return latestMessageId ? { latestMessageId } : {};
          }
          messages.push({
            role: 'tool',
            tool_name: toolCall.function.name,
            content: boundedToolResult(toolResult.result),
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
    } catch (error) {
      if (!(error instanceof ContextBudgetError) && !isContextOverflow(error)) throw error;
      console.warn('Context could not fit after compaction:', error);
      return allowPublicResponse
        ? {
            response:
              'I could not fit this request alongside my instructions. Shorten the input or increase OLLAMA_NUM_CTX; any tool actions already reported still took place.',
          }
        : {};
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
    attachmentBudget = { remaining: ATTACHMENTS_PER_CONTEXT, imagesRemaining: 2 },
  ): Promise<OllamaMessage[]> {
    const [systemPrompt, relevantMemories] = await Promise.all([
      this.readSystemPrompt(),
      this.findRelevantMemories(chat),
    ]);
    const recentIds = new Set(
      chat.slice(-20).flatMap((message) => [message.author.id, ...message.mentions.users.keys()]),
    );
    const latestText = chat
      .slice(-5)
      .map((message) => message.content.toLocaleLowerCase())
      .join(' ');
    const selectedMembers = [...(members ?? [])]
      .sort((left, right) => {
        const score = (member: GuildMember) =>
          Number(recentIds.has(member.id)) * 2 +
          Number(
            [member.user.username, member.nickname].some(
              (name) => name && latestText.includes(name.toLocaleLowerCase()),
            ),
          );
        return score(right) - score(left);
      })
      .slice(0, 20);
    return [
      {
        role: 'system',
        content: buildSystemPrompt(
          systemPrompt,
          emojis
            ?.filter((emoji) => emoji.id)
            .slice(0, 30)
            .map((emoji) => `<${emoji.animated ? 'a' : ''}:${emoji.name ?? 'emoji'}:${emoji.id}>`)
            .join('\n'),
          JSON.stringify(
            selectedMembers.map((member) => ({
              username: member.user.username,
              nickname: member.nickname,
              id: member.id,
            })) ?? [],
          ),
          this.recentParticipants(chat),
          `trigger=${trigger}; public_response_allowed=${allowPublicResponse}; clanker_trigger=${trigger !== 'reflection_tick' && this.hasClankerTrigger(chat)}; catalogs are partial; get_member_presence can resolve uncatalogued names${activity ? `; event=${activity.slice(-2000)}` : ''}`,
          relevantMemories
            .map((memory) => `[${memory.id}] ${memory.text.slice(0, 500)}`)
            .join('\n')
            .slice(0, 3000),
        ),
      },
      ...(await this.toOllamaMessagesWithAttachments(chat, attachmentBudget)),
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
  private async insertPendingMessages(
    messages: OllamaMessage[],
    attachmentBudget = { remaining: ATTACHMENTS_PER_CONTEXT, imagesRemaining: 2 },
  ): Promise<string | undefined> {
    if (this.pendingMessages.length === 0) {
      return undefined;
    }
    const pending = this.pendingMessages.splice(0);
    console.log(`Inserted ${pending.length} pending message(s) into Ollama chat`);
    messages.push(...(await this.toOllamaMessagesWithAttachments(pending, attachmentBudget)));
    return pending.at(-1)?.id;
  }
  private async toOllamaMessagesWithAttachments(
    chat: Message[],
    budget = { remaining: ATTACHMENTS_PER_CONTEXT, imagesRemaining: 2 },
  ): Promise<OllamaMessage[]> {
    const messages = chat.map((message) => this.toOllamaMessage(message));
    const downloads: Promise<void>[] = [];
    // Prefer recent attachments; older files remain discoverable through message metadata.
    for (let index = chat.length - 1; index >= 0 && budget.remaining > 0; index -= 1) {
      const message = chat[index]!;
      const result = messages[index]!;
      const attachments = [...message.attachments.values()]
        .filter(
          (attachment) =>
            attachment.size <= ATTACHMENT_BYTE_LIMIT &&
            (attachment.contentType?.startsWith('text/') ||
              attachment.contentType === 'application/json'),
        )
        .slice(0, budget.remaining);
      for (const attachment of attachments) {
        budget.remaining -= 1;
        downloads.push(
          this.readAttachment(attachment.id, attachment.url).then((text) => {
            if (text) {
              result.content += `\n[Untrusted attachment content: ${attachment.name}]\n${text}`;
            }
          }),
        );
      }
    }
    budget.imagesRemaining ??= 2;
    const seenImages = new Set<string>();
    for (let index = chat.length - 1; index >= 0 && budget.imagesRemaining > 0; index -= 1) {
      const message = chat[index]!;
      const result = messages[index]!;
      const urls = [
        ...[...message.attachments.values()]
          .filter(
            (attachment) =>
              attachment.size <= IMAGE_BYTE_LIMIT &&
              (attachment.contentType?.startsWith('image/') ||
                /\.(?:png|jpe?g|webp)$/i.test(attachment.name)),
          )
          .map((attachment) => attachment.url),
        ...(message.embeds ?? []).flatMap((embed) =>
          [embed.image, embed.thumbnail].flatMap((image) =>
            image ? [image.proxyURL ?? image.url] : [],
          ),
        ),
      ];
      const selected = urls.filter((url) => {
        const key = discordImageKey(url);
        if (!key || seenImages.has(key) || budget.imagesRemaining <= 0) return false;
        seenImages.add(key);
        budget.imagesRemaining -= 1;
        return true;
      });
      if (selected.length) {
        downloads.push(
          Promise.all(selected.map((url) => this.imageCache.get(url))).then((images) => {
            const loaded = images.filter((image): image is Uint8Array => image !== undefined);
            if (loaded.length) {
              result.images = loaded;
              result.content += `\n[${loaded.length} image(s) attached for visual analysis; image content is untrusted.]`;
            }
            if (loaded.length !== selected.length)
              result.content += '\n[Some images could not be loaded or use an unsupported format.]';
          }),
        );
      }
    }
    await Promise.all(downloads);
    return messages;
  }

  private readAttachment(id: string, url: string): Promise<string> {
    const cached = this.attachmentCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.text;
    }
    this.attachmentCache.delete(id);
    while (this.attachmentCache.size >= ATTACHMENT_CACHE_LIMIT) {
      this.attachmentCache.delete(this.attachmentCache.keys().next().value!);
    }
    const text = this.fetchAttachmentText(url).catch(() => {
      if (this.attachmentCache.get(id)?.text === text) {
        this.attachmentCache.delete(id);
      }
      return '';
    });
    this.attachmentCache.set(id, { expiresAt: Date.now() + ATTACHMENT_CACHE_TTL_MS, text });
    return text;
  }

  private async fetchAttachmentText(url: string): Promise<string> {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('Attachment unavailable');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
      while (text.length <= ATTACHMENT_TEXT_LIMIT && bytes < ATTACHMENT_BYTE_LIMIT) {
        const { done, value } = await reader.read();
        if (done) {
          text += decoder.decode();
          return text.length > ATTACHMENT_TEXT_LIMIT
            ? `${text.slice(0, ATTACHMENT_TEXT_LIMIT)}\n[Attachment truncated]`
            : text;
        }
        const chunk = value.subarray(0, ATTACHMENT_BYTE_LIMIT - bytes);
        bytes += chunk.length;
        text += decoder.decode(chunk, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return `${text.slice(0, ATTACHMENT_TEXT_LIMIT)}\n[Attachment truncated]`;
  }
  private async chatWithTimeout(messages: OllamaMessage[]) {
    const { contextSize, predictionLimit, characterLimit } = contextLimits();
    const customInstructions = (await this.readSystemPrompt()).trim();
    const current = messages.map((message, index) =>
      index === 0 && message.role === 'system'
        ? {
            ...message,
            content: message.content.replace(
              /(<custom_instructions>\n)[\s\S]*?(\n<\/custom_instructions>)/,
              (_match, start: string, end: string) => `${start}${customInstructions}${end}`,
            ),
          }
        : message,
    );
    const toolCharacters = Buffer.byteLength(JSON.stringify(tools));
    let budget = characterLimit;
    const input = {
      model: process.env.OLLAMA_MODEL ?? 'gemma4:e4b',
      messages: fitContext(current, budget, toolCharacters),
      tools,
      think: this.ollamaThink(),
      keep_alive: this.ollamaKeepAlive(),
      options: {
        num_ctx: contextSize,
        num_predict: predictionLimit,
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
    console.log(
      `Ollama request: ${input.messages.length}/${messages.length} messages, ${tools.length} tools, ${budget} input budget, ${predictionLimit} output tokens`,
    );
    let lastError: unknown;
    let contextRetries = 0;
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
        if (isContextOverflow(error) && contextRetries < 2) {
          contextRetries += 1;
          budget = Math.floor(budget * 0.75);
          input.messages = fitContext(current, budget, toolCharacters);
          console.warn(`Retrying context overflow with ${budget} input budget`);
          attempt -= 1;
          continue;
        }
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
        id: attachment.id,
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
          `attachment ${attachment.id}: ${attachment.name} (${attachment.contentType ?? 'unknown'}, ${attachment.size} bytes) ${attachment.url}`,
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
    // Reject an edit before persistence if it leaves no room for a subsequent request.
    fitContext(
      [{ role: 'system', content: buildSystemPrompt(prompt) }],
      contextLimits().characterLimit - 1500,
      Buffer.byteLength(JSON.stringify(tools)),
    );
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
      arguments: compactToolArguments(call.function.name, call.function.arguments),
    });
    const toolResult = await this.handleToolCall(call, executeAction);
    await this.appendChatState({
      action: 'tool_result',
      at: new Date().toISOString(),
      trigger,
      tool: call.function.name,
      result: compactToolResult(call.function.name, toolResult.result),
    });
    return toolResult;
  }
  private async handleToolAction(
    name: string,
    args: Record<string, unknown>,
    executeAction?: (action: DiscordAction) => Promise<unknown>,
  ): Promise<{ stop: boolean; result: unknown }> {
    console.log(`Tool call: ${name}`, compactToolArguments(name, args));
    try {
      return await executeRegisteredTool(name, args, {
        discord: async (action) => await this.runDiscordAction(executeAction, action),
        updateSystemPrompt: async (markdown) => {
          await this.writeSystemPrompt(markdown);
          console.log(`Updated system prompt at ${this.systemPromptPath}`);
          return {
            stop: false,
            result: { tool: 'update_system_prompt', ok: true, path: this.systemPromptPath },
          };
        },
        searchWeb: async (query, limit, category) => await this.searchWeb(query, limit, category),
        searchWikipedia: async (query, limit) => await this.searchWikipedia(query, limit),
        searchWikidata: async (query, limit, language) =>
          await this.searchWikidata(query, limit, language),
        readWebPage: async (url, maxCharacters) => await this.readWebPage(url, maxCharacters),
        changeProfilePicture: async ({ imageUrl, messageId, attachmentId }) => {
          if (imageUrl && !this.approvedProfileImageUrls.has(imageUrl)) {
            return {
              stop: false,
              result: {
                tool: 'change_profile_picture',
                ok: false,
                error: 'image_url must come from a search result in this turn.',
              },
            };
          }
          return await this.runDiscordAction(executeAction, {
            type: 'change_profile_picture',
            ...(imageUrl ? { imageUrl } : {}),
            ...(messageId ? { messageId } : {}),
            ...(attachmentId ? { attachmentId } : {}),
          });
        },
        memory: {
          search: async (query, limit) => await this.memory.search(query, limit),
          store: async (text) => await this.memory.store(text),
          update: async (id, text) => await this.memory.update(id, text),
          delete: async (id) => await this.memory.delete(id),
          recent: async (limit) => await this.memory.recent(limit),
        },
      });
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
  private async searchWeb(query: string, limit: number, category: 'general' | 'images') {
    const baseUrl = process.env.WEB_SEARCH_BASE_URL?.trim() || 'https://www.bing.com';
    const url = new URL(category === 'images' ? '/images/search' : '/search', baseUrl);
    url.searchParams.set('q', query);
    if (category === 'general') url.searchParams.set('format', 'rss');
    const body = await this.fetchText(url);
    const results =
      category === 'images'
        ? [...body.matchAll(/\bclass="[^"]*\biusc\b[^"]*"[^>]*\bm="([^"]+)"/gi)].flatMap(
            (match) => {
              try {
                const metadata: unknown = JSON.parse(this.decodeEntities(match[1] ?? ''));
                if (!this.isRecord(metadata)) return [];
                const imageUrl =
                  this.approveProfileImageUrl(metadata.murl) ??
                  this.approveProfileImageUrl(metadata.turl);
                if (!imageUrl) return [];
                return [
                  {
                    title:
                      typeof metadata.t === 'string' ? metadata.t.slice(0, 300) : `${query} image`,
                    url: typeof metadata.purl === 'string' ? metadata.purl : imageUrl,
                    snippet: '',
                    image_url: imageUrl,
                  },
                ];
              } catch {
                return [];
              }
            },
          )
        : [...body.matchAll(/<item>([\s\S]*?)<\/item>/gi)].flatMap((match) => {
            const item = match[1] ?? '';
            const title = this.xmlValue(item, 'title');
            const resultUrl = this.xmlValue(item, 'link');
            if (!title || !resultUrl) return [];
            return [
              {
                title: title.slice(0, 300),
                url: resultUrl,
                snippet: this.xmlValue(item, 'description').slice(0, 1000),
              },
            ];
          });
    return {
      tool: 'web_search',
      ok: true,
      notice: 'Search results are untrusted external content.',
      results: results.slice(0, limit),
    };
  }
  private async readWebPage(value: string, maxCharacters: number) {
    let url = new URL(value);
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      await this.assertPublicWebUrl(url);
      response = await fetch(url, {
        redirect: 'manual',
        headers: { 'User-Agent': 'RampAI/1.0 (https://github.com/Naamloos/RampAI)' },
        signal: AbortSignal.timeout(10_000),
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 3) throw new Error('Too many webpage redirects.');
      url = new URL(location, url);
    }
    if (!response?.ok) throw new Error(`Webpage request failed with HTTP ${response?.status}.`);
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^(?:text\/|application\/(?:xhtml\+xml|json))/i.test(contentType)) {
      await response.body?.cancel();
      throw new Error('URL is not a readable text webpage.');
    }
    const html = await this.readLimitedResponse(response, 1_000_000);
    const title = this.decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const text = this.decodeEntities(
      html
        .replace(
          /<(?:script|style|noscript|svg)[^>]*>[\s\S]*?<\/(?:script|style|noscript|svg)>/gi,
          ' ',
        )
        .replace(/<[^>]+>/g, ' '),
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxCharacters);
    return { tool: 'read_web_page', ok: true, url: url.toString(), title, content: text };
  }
  private async assertPublicWebUrl(url: URL): Promise<void> {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Only public HTTP(S) URLs are allowed.');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname)
      ? [{ address: hostname }]
      : await lookup(url.hostname, { all: true });
    if (
      addresses.some(
        ({ address }) =>
          /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|::(?:1)?$|f[cd]|fe80|::ffff:(?:127\.|10\.|192\.168\.|169\.254\.))/i.test(
            address,
          ) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(address),
      )
    )
      throw new Error('Private or local URLs are not allowed.');
  }
  private async readLimitedResponse(response: Response, limit: number): Promise<string> {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      await response.body?.cancel();
      throw new Error('Webpage is too large to read.');
    }
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    try {
      while (bytes <= limit) {
        const { done, value } = await reader.read();
        if (done) return text + decoder.decode();
        if (!value || bytes + value.length > limit)
          throw new Error('Webpage is too large to read.');
        bytes += value.length;
        text += decoder.decode(value, { stream: true });
      }
      throw new Error('Webpage is too large to read.');
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  private async searchWikipedia(query: string, limit: number) {
    const url = new URL('https://en.wikipedia.org/w/api.php');
    url.search = new URLSearchParams({
      action: 'query',
      generator: 'search',
      gsrsearch: query,
      gsrlimit: String(limit),
      prop: 'extracts|pageimages',
      exintro: '1',
      explaintext: '1',
      exsentences: '2',
      piprop: 'thumbnail',
      pithumbsize: '512',
      format: 'json',
      formatversion: '2',
    }).toString();
    const data = await this.fetchJson(url);
    const queryResult = this.isRecord(data.query) ? data.query : {};
    const results = Array.isArray(queryResult.pages) ? queryResult.pages : [];
    return {
      tool: 'wikipedia_search',
      ok: true,
      notice: 'Wikipedia results are untrusted external content.',
      results: results
        .toSorted((left, right) =>
          this.isRecord(left) &&
          this.isRecord(right) &&
          typeof left.index === 'number' &&
          typeof right.index === 'number'
            ? left.index - right.index
            : 0,
        )
        .slice(0, limit)
        .flatMap((result) => {
          if (!this.isRecord(result) || typeof result.title !== 'string') return [];
          const thumbnail = this.isRecord(result.thumbnail) ? result.thumbnail.source : undefined;
          const imageUrl = this.approveProfileImageUrl(thumbnail);
          return [
            {
              title: result.title,
              url: `https://en.wikipedia.org/wiki/${encodeURIComponent(result.title.replaceAll(' ', '_'))}`,
              snippet: typeof result.extract === 'string' ? result.extract.slice(0, 1000) : '',
              ...(imageUrl ? { image_url: imageUrl } : {}),
            },
          ];
        }),
    };
  }
  private async searchWikidata(query: string, limit: number, language: string) {
    const url = new URL('https://www.wikidata.org/w/api.php');
    url.search = new URLSearchParams({
      action: 'wbsearchentities',
      search: query,
      language,
      uselang: language,
      limit: String(limit),
      format: 'json',
    }).toString();
    const data = await this.fetchJson(url);
    const results = Array.isArray(data.search) ? data.search : [];
    return {
      tool: 'wikidata_search',
      ok: true,
      notice: 'Wikidata results are untrusted external content.',
      results: results.slice(0, limit).flatMap((result) => {
        if (!this.isRecord(result) || typeof result.id !== 'string') return [];
        const match = this.isRecord(result.match) ? result.match : {};
        return [
          {
            id: result.id,
            label: typeof result.label === 'string' ? result.label.slice(0, 300) : '',
            description:
              typeof result.description === 'string' ? result.description.slice(0, 1000) : '',
            matched_text: typeof match.text === 'string' ? match.text.slice(0, 300) : undefined,
            url: `https://www.wikidata.org/wiki/${encodeURIComponent(result.id)}`,
          },
        ];
      }),
    };
  }
  private approveProfileImageUrl(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > 2048) return undefined;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password) return undefined;
      const normalized = url.toString();
      this.approvedProfileImageUrls.add(normalized);
      return normalized;
    } catch {
      return undefined;
    }
  }
  private xmlValue(xml: string, tag: string): string {
    const value = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml)?.[1] ?? '';
    return this.decodeEntities(value.replace(/^<!\[CDATA\[|\]\]>$/g, '')).replace(/<[^>]*>/g, '');
  }
  private decodeEntities(value: string): string {
    return value
      .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
        String.fromCodePoint(Number.parseInt(code, 16)),
      )
      .replace(/&#(\d+);/g, (_match, code: string) =>
        String.fromCodePoint(Number.parseInt(code, 10)),
      )
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }
  private async fetchText(url: URL): Promise<string> {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'RampAI/1.0 (https://github.com/Naamloos/RampAI)' },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Search request failed with HTTP ${response.status}.`);
    }
    return await response.text();
  }
  private async fetchJson(url: URL): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'RampAI/1.0 (https://github.com/Naamloos/RampAI)' },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Search request failed with HTTP ${response.status}.`);
    }
    const data: unknown = await response.json();
    if (!this.isRecord(data)) {
      throw new Error('Search returned an invalid response.');
    }
    return data;
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
    const shouldCooldown = ![
      'read_attachment',
      'list_reaction_users',
      'search_channel_history',
      'get_member_presence',
      'get_message',
      'get_poll_results',
      'list_pinned_messages',
      'list_scheduled_messages',
    ].includes(action.type);
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
  private ollamaKeepAlive(): string | number {
    const value = process.env.OLLAMA_KEEP_ALIVE?.trim() || '30m';
    return /^-?\d+$/.test(value) ? Number(value) : value;
  }
}
