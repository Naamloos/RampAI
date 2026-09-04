import type {
  Client,
  Events,
  Message,
  MessageReaction,
  OmitPartialGroupDMChannel,
  PartialMessage,
  PartialMessageReaction,
  PartialPollAnswer,
  PartialUser,
  PollAnswer,
  TextChannel,
  User,
} from 'discord.js';
import { ActivityType } from 'discord.js';
import { AsyncEventHandler } from '../@types/event-handler.js';
import ScheduledMessageStore from '../discord/scheduled-message.store.js';
import OllamaService from '../llm/ollama.service.js';
import type { DiscordAction } from '../llm/tools.js';

const DISCORD_MESSAGE_LIMIT = 2000;

function messageLimit(): number {
  const value = Number(process.env.MESSAGE_LIMIT ?? 50);
  return Number.isInteger(value) ? Math.min(100, Math.max(2, value)) : 50;
}

export default class MessageCreateEvent extends AsyncEventHandler<Events.MessageCreate> {
  private readonly scheduledMessages = new ScheduledMessageStore();
  private processing = false;

  constructor(client: Client) {
    super(client);
  }

  async handle(message: OmitPartialGroupDMChannel<Message<boolean>>): Promise<void> {
    console.log(`${message.author.displayName} (${message.author.id}): ${message.content}`);
    if (message.author.bot || !this.isConfiguredChannel(message.channel.id)) {
      return;
    }

    const ollama = OllamaService.getInstance();
    if (this.processing || ollama.getIsThinking()) {
      ollama.addIncomingMessage(message);
      return;
    }

    await this.processChannel(message.channel as TextChannel, 'message_event');
  }

  async handleUpdate(message: Message | PartialMessage): Promise<void> {
    const updated = message.partial ? await message.fetch().catch(() => undefined) : message;
    if (!updated || updated.author.bot || !this.isConfiguredChannel(updated.channelId)) {
      return;
    }
    await this.processChannel(updated.channel as TextChannel, 'message_update');
  }

  async handleDelete(message: Message | PartialMessage): Promise<void> {
    if (!this.isConfiguredChannel(message.channelId) || message.author?.bot) {
      return;
    }
    const channel = message.channel;
    if (!channel.isTextBased() || channel.isDMBased()) {
      return;
    }
    await this.processChannel(
      channel as TextChannel,
      'message_delete',
      `A message was deleted (Discord message ${message.id})${message.content ? `: “${message.content.slice(0, 300)}”` : '.'}`,
    );
  }

  async handleReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
    added: boolean,
  ): Promise<void> {
    if (user.bot || !this.isConfiguredChannel(reaction.message.channelId)) {
      return;
    }
    const message = reaction.message.partial
      ? await reaction.message.fetch().catch(() => undefined)
      : reaction.message;
    if (!message) {
      return;
    }
    const emoji = reaction.emoji.id
      ? `<${reaction.emoji.animated ? 'a' : ''}:${reaction.emoji.name ?? 'emoji'}:${reaction.emoji.id}>`
      : (reaction.emoji.name ?? 'emoji');
    await this.processChannel(
      message.channel as TextChannel,
      added ? 'reaction_add' : 'reaction_remove',
      `${user.displayName} <@${user.id}> ${added ? 'added' : 'removed'} ${emoji} on Discord message ${message.id}: “${message.content.slice(0, 300)}”`,
    );
  }

  async handlePollVote(
    answer: PollAnswer | PartialPollAnswer,
    userId: string,
    added: boolean,
  ): Promise<void> {
    const message = answer.poll.message;
    if (!this.isConfiguredChannel(message.channelId) || !(message.channel instanceof TextChannel)) {
      return;
    }
    const choice = answer.text ?? answer.emoji?.name ?? `answer ${answer.id}`;
    await this.processChannel(
      message.channel,
      added ? 'poll_vote_add' : 'poll_vote_remove',
      `<@${userId}> ${added ? 'voted for' : 'removed their vote from'} “${choice}” in poll “${answer.poll.question.text ?? 'unknown'}” (message ${message.id}).`,
    );
  }

  async tick(channel: TextChannel): Promise<void> {
    await this.flushScheduledMessages(channel);
    if (OllamaService.getInstance().getIsThinking()) {
      return;
    }

    const latest = (await channel.messages.fetch({ limit: 1 })).first();
    if (
      latest &&
      latest.author.id !== this.client.user?.id &&
      !(await OllamaService.getInstance().hasProcessedLatestMessage(latest.id))
    ) {
      await this.processChannel(channel, 'autonomous_tick');
      return;
    }

    if (await OllamaService.getInstance().isReflectionDue()) {
      await this.processChannel(
        channel,
        'reflection_tick',
        'Silently reflect on recent relationships, durable memories, and gradual personality development. Consolidate or correct memories and update custom personality instructions only when experience supports it.',
        false,
      );
    }
  }

  async flushScheduledMessages(channel: TextChannel): Promise<void> {
    await this.sendDueMessages(channel);
  }

  private async processChannel(
    channel: TextChannel,
    trigger: string,
    activity?: string,
    allowPublicResponse = true,
  ): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;
    try {
      const recent = Array.from(
        (await channel.messages.fetch({ limit: messageLimit() })).values(),
      ).reverse();
      const known = new Set(recent.map((message) => message.id));
      const referenceIds = [
        ...new Set(
          recent
            .map((message) => message.reference?.messageId)
            .filter((id): id is string => typeof id === 'string' && !known.has(id)),
        ),
      ].slice(0, 10);
      const referenced = (
        await Promise.all(
          referenceIds.map((id) => channel.messages.fetch(id).catch(() => undefined)),
        )
      ).filter((message): message is Message => Boolean(message));
      const messages = [...referenced, ...recent].sort(
        (left, right) => left.createdTimestamp - right.createdTimestamp,
      );
      await this.processMessages(channel, messages, trigger, activity, allowPublicResponse);
    } finally {
      this.processing = false;
    }
  }

  private async processMessages(
    channel: TextChannel,
    messages: Message<boolean>[],
    trigger: string,
    activity?: string,
    allowPublicResponse = true,
  ): Promise<void> {
    const ollama = OllamaService.getInstance();
    if (ollama.getIsThinking()) {
      return;
    }

    if (allowPublicResponse) {
      await channel.sendTyping().catch((error) => console.warn('Failed to send typing:', error));
    }

    const reply = await ollama.processFromChat(
      messages,
      channel.guild.emojis.cache.map((emoji) => emoji),
      channel.guild.members.cache.map((member) => member),
      trigger,
      (action) => this.executeAction(channel, messages, action),
      activity,
      allowPublicResponse,
    );

    if (!reply) {
      return;
    }
    const latestMessageId = reply.latestMessageId ?? messages.at(-1)?.id;
    if (!reply.response) {
      if (latestMessageId) {
        await ollama.recordProcessedMessage(latestMessageId, trigger);
      }
      return;
    }
    const publicResponse = this.applyMentionPolicy(channel, messages, reply.response);
    if (!publicResponse) {
      if (latestMessageId) {
        await ollama.recordProcessedMessage(latestMessageId, trigger);
      }
      return;
    }
    if (this.isRepeatedBotMessage(messages, publicResponse)) {
      console.warn('Skipped repeated bot response');
      if (latestMessageId) {
        await ollama.recordProcessedMessage(latestMessageId, trigger);
      }
      return;
    }
    await this.sendChunks(channel, publicResponse, trigger);
    if (latestMessageId) {
      await ollama.recordProcessedMessage(latestMessageId, trigger);
    }
  }

  private async executeAction(
    channel: TextChannel,
    messages: Message<boolean>[],
    action: DiscordAction,
  ): Promise<unknown> {
    if (action.type === 'change_nickname') {
      const member = channel.guild.members.me;
      if (!member) {
        return { tool: action.type, ok: false, error: 'Bot guild member is unavailable.' };
      }
      await member.setNickname(action.nickname);
      return { tool: action.type, ok: true, nickname: action.nickname };
    }

    if (action.type === 'get_member_presence') {
      const query = action.member.trim();
      const id = /^<@!?(\d+)>$/.exec(query)?.[1] ?? (/^\d{17,20}$/.test(query) ? query : undefined);
      let member = id
        ? (channel.guild.members.cache.get(id) ?? (await channel.guild.members.fetch(id)))
        : undefined;
      if (!member) {
        const normalized = query.toLocaleLowerCase();
        const exact = channel.guild.members.cache.filter((candidate) =>
          [candidate.user.username, candidate.nickname, candidate.displayName].some(
            (name) => name?.toLocaleLowerCase() === normalized,
          ),
        );
        const matches =
          exact.size > 0
            ? exact
            : channel.guild.members.cache.filter((candidate) =>
              [candidate.user.username, candidate.nickname, candidate.displayName].some((name) =>
                name?.toLocaleLowerCase().includes(normalized),
              ),
            );
        if (matches.size !== 1) {
          return {
            tool: action.type,
            ok: false,
            error: matches.size === 0 ? 'No matching member.' : 'Member name is ambiguous.',
            candidates: matches
              .map((candidate) => ({
                username: candidate.user.username,
                nickname: candidate.nickname,
                id: candidate.id,
              }))
              .slice(0, 10),
          };
        }
        member = matches.first();
      }
      if (!member) {
        return { tool: action.type, ok: false, error: 'No matching member.' };
      }
      const refreshed = await channel.guild.members
        .fetch({ user: [member.id], withPresences: true })
        .catch(() => undefined);
      member = refreshed?.get(member.id) ?? member;
      const presence = member.presence;
      return {
        tool: action.type,
        ok: true,
        member: { id: member.id, displayName: member.displayName },
        status: presence?.status ?? 'offline_or_invisible',
        clients: presence?.clientStatus ?? {},
        activities:
          presence?.activities.map((activity) => ({
            type: ActivityType[activity.type],
            name: activity.name,
            details: activity.details,
            state: activity.state,
            applicationId: activity.applicationId,
            url: activity.url,
            startedAt: activity.timestamps?.start?.toISOString(),
          })) ?? [],
      };
    }

    if (action.type === 'create_poll') {
      const sent = await channel.send({
        poll: {
          question: { text: this.applyMentionPolicy(channel, messages, action.question) },
          answers: action.answers.map((text) => ({
            text: this.applyMentionPolicy(channel, messages, text),
          })),
          duration: action.durationHours,
          allowMultiselect: false,
        },
      });
      await OllamaService.getInstance().recordDiscordMessage(sent, 'tool:create_poll');
      return { tool: action.type, ok: true, messageId: sent.id };
    }

    if (action.type === 'search_channel_history') {
      return {
        tool: action.type,
        ok: true,
        messages: await this.searchHistory(channel, action.query, action.limit),
      };
    }

    if (action.type === 'schedule_message') {
      const content = this.applyMentionPolicy(channel, messages, action.content);
      const scheduled = await this.scheduledMessages.schedule(content, action.delayMinutes);
      return { tool: action.type, ok: true, id: scheduled.id, dueAt: scheduled.dueAt };
    }

    const target = await this.fetchMessage(channel, messages, action.messageId);
    if (action.type === 'reply_to_message') {
      const chunks = this.splitMessage(this.applyMentionPolicy(channel, messages, action.content));
      const first = chunks.shift();
      if (first) {
        const sent = await target.reply({
          content: first,
          allowedMentions: this.allowedMentions(first),
        });
        await OllamaService.getInstance().recordDiscordMessage(sent, 'tool:reply_to_message');
      }
      for (const chunk of chunks) {
        await this.sendChunks(channel, chunk, 'tool:reply_to_message');
      }
      return { tool: action.type, ok: true };
    }

    if (action.type === 'add_reaction' || action.type === 'remove_reaction') {
      const emoji = this.validReactionEmoji(channel, action.emoji);
      if (!emoji) {
        return { tool: action.type, ok: false, error: 'Invalid or unavailable emoji.' };
      }
      if (action.type === 'add_reaction') {
        await target.react(emoji);
      } else {
        const ownReaction = target.reactions.cache.find(
          (reaction) => this.reactionText(reaction.emoji) === emoji && reaction.me,
        );
        if (!ownReaction) {
          return { tool: action.type, ok: false, error: 'The bot has no matching reaction.' };
        }
        await ownReaction.users.remove();
      }
      return { tool: action.type, ok: true };
    }

    if (action.type === 'edit_message' || action.type === 'delete_message') {
      if (target.author.id !== this.client.user?.id) {
        return {
          tool: action.type,
          ok: false,
          error: 'Only bot-authored messages can be changed.',
        };
      }
      if (action.type === 'edit_message') {
        const content = this.applyMentionPolicy(channel, messages, action.content);
        await target.edit({
          content: content.slice(0, DISCORD_MESSAGE_LIMIT),
          allowedMentions: this.allowedMentions(content),
        });
      } else {
        await target.delete();
      }
      return { tool: action.type, ok: true };
    }

    if (action.type === 'pin_message') {
      await target.pin();
    } else {
      await target.unpin();
    }
    return { tool: action.type, ok: true };
  }

  private async sendDueMessages(channel: TextChannel): Promise<void> {
    for (const entry of await this.scheduledMessages.takeDue()) {
      try {
        await this.sendChunks(channel, entry.content, 'scheduled_message');
      } catch (error) {
        await this.scheduledMessages.restore(entry);
        throw error;
      }
    }
  }

  private async sendChunks(channel: TextChannel, text: string, trigger: string): Promise<void> {
    for (const content of this.splitMessage(text)) {
      const sent = await channel.send({ content, allowedMentions: this.allowedMentions(content) });
      await OllamaService.getInstance().recordDiscordMessage(sent, trigger);
    }
  }

  private splitMessage(text: string): string[] {
    const chunks: string[] = [];
    let remaining = this.sanitizeOutgoingText(text);
    while (remaining) {
      if (remaining.length <= DISCORD_MESSAGE_LIMIT) {
        chunks.push(remaining);
        break;
      }
      const candidate = remaining.slice(0, DISCORD_MESSAGE_LIMIT);
      const splitAt = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf(' '));
      const end = splitAt > DISCORD_MESSAGE_LIMIT / 2 ? splitAt : DISCORD_MESSAGE_LIMIT;
      chunks.push(remaining.slice(0, end).trimEnd());
      remaining = remaining.slice(end).trimStart();
    }
    return chunks;
  }

  private sanitizeOutgoingText(content: string): string {
    return content.replace(/^(?:\s*\[Discord message \d+[^\]\r\n]*\]\s*)+/i, '').trim();
  }

  private applyMentionPolicy(
    channel: TextChannel,
    messages: Message<boolean>[],
    content: string,
  ): string {
    const allowed = new Set<string>();

    for (const message of messages) {
      if (message.author.id !== this.client.user?.id) {
        // Someone participating in the conversation may always be mentioned.
        allowed.add(message.author.id);
      }

      // Explicitly mentioned users should always remain mentionable.
      // This does not rely on guild.members.cache.
      for (const userId of message.mentions.users.keys()) {
        allowed.add(userId);
      }
    }

    const latest = messages.findLast((message) => !message.author.bot)?.content ?? '';

    if (/\b(?:mention|ping|tag|notify|noem|vermeld)\b/i.test(latest)) {
      for (const member of channel.guild.members.cache.values()) {
        allowed.add(member.id);
      }
    }

    return this.sanitizeOutgoingText(content).replace(
      /<@!?(\d+)>/g,
      (mention, id: string) => (allowed.has(id) ? mention : ''),
    );
  }

  private allowedMentions(content: string) {
    const users = new Set(
      [...content.matchAll(/<@!?(\d+)>/g)].flatMap((match) =>
        match[1] ? [match[1]] : [],
      ),
    );

    return {
      parse: [],
      users: [...users],
      repliedUser: false,
    };
  }

  private async searchHistory(channel: TextChannel, query: string, limit: number) {
    const results: Message[] = [];
    let before: string | undefined;
    const normalized = query.toLocaleLowerCase();
    const configuredScanLimit = Number(process.env.HISTORY_SCAN_LIMIT ?? 500);
    const scanLimit = Number.isInteger(configuredScanLimit)
      ? Math.min(1000, Math.max(100, configuredScanLimit))
      : 500;

    for (let scanned = 0; scanned < scanLimit && results.length < limit; scanned += 100) {
      const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (page.size === 0) {
        break;
      }
      results.push(
        ...page
          .filter((message) => message.content.toLocaleLowerCase().includes(normalized))
          .values(),
      );
      before = page.last()?.id;
    }

    return results.slice(0, limit).map((message) => ({
      id: message.id,
      author: `${message.author.displayName} <@${message.author.id}>`,
      content: message.content.slice(0, 1000),
      createdAt: message.createdAt.toISOString(),
    }));
  }

  private isRepeatedBotMessage(messages: Message<boolean>[], response: string): boolean {
    const text = this.normalizeText(response);
    return messages.some(
      (message) =>
        message.author.id === this.client.user?.id && this.normalizeText(message.content) === text,
    );
  }

  private normalizeText(text: string): string {
    return text.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  }

  private async fetchMessage(
    channel: TextChannel,
    messages: Message<boolean>[],
    messageId: string,
  ): Promise<Message> {
    return (
      messages.find((message) => message.id === messageId) ??
      (await channel.messages.fetch(messageId))
    );
  }

  private validReactionEmoji(channel: TextChannel, emoji: string): string | undefined {
    const value = emoji.trim();
    const custom = /^<(a?):([A-Za-z0-9_]+):(\d+)>$/.exec(value);
    if (custom) {
      const [, animated, name, id] = custom;
      const guildEmoji = channel.guild.emojis.cache.get(id ?? '');
      return guildEmoji?.name === name && (animated === 'a') === guildEmoji.animated
        ? this.reactionText(guildEmoji)
        : undefined;
    }
    return this.isUnicodeEmoji(value) ? value : undefined;
  }

  private reactionText(emoji: {
    id: string | null;
    name: string | null;
    animated?: boolean | null;
  }): string {
    return emoji.id
      ? `<${emoji.animated ? 'a' : ''}:${emoji.name ?? 'emoji'}:${emoji.id}>`
      : (emoji.name ?? '');
  }

  private isUnicodeEmoji(value: string): boolean {
    return (
      /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\uFE0F|\u200D|[0-9#*]\uFE0F?\u20E3)+$/u.test(
        value,
      ) && /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u.test(value)
    );
  }

  private isConfiguredChannel(channelId: string): boolean {
    return Boolean(process.env.DISCORD_CHANNEL_ID && channelId === process.env.DISCORD_CHANNEL_ID);
  }
}
