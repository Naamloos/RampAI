import type { Client, Events, Message, OmitPartialGroupDMChannel, TextChannel } from 'discord.js';
import { AsyncEventHandler } from '../@types/event-handler.js';
import OllamaService from '../llm/ollama.service.js';
import type { DiscordAction } from '../llm/tools.js';

function messageLimit(): number {
  return Number(process.env.MESSAGE_LIMIT ?? 50);
}

export default class MessageCreateEvent extends AsyncEventHandler<Events.MessageCreate> {
  constructor(client: Client) {
    super(client);
  }

  async handle(message: OmitPartialGroupDMChannel<Message<boolean>>): Promise<void> {
    console.log(`${message.author.displayName} (${message.author.id}): ${message.content}`);

    if (message.author.bot || message.channel.id !== process.env.DISCORD_CHANNEL_ID) {
      return;
    }

    const ollamaService = OllamaService.getInstance();
    if (ollamaService.getIsThinking()) {
      ollamaService.addIncomingMessage(message);
      return;
    }

    const channel = message.channel as TextChannel;
    const previousMessages = await channel.messages.fetch({
      limit: messageLimit() - 1,
      before: message.id,
    });
    const messages: Message<boolean>[] = Array.from(previousMessages.values()).reverse();
    messages.push(message);

    await this.processMessages(channel, messages, 'message_event');
  }

  async tick(channel: TextChannel): Promise<void> {
    const latest = await channel.messages.fetch({ limit: 1 });
    const latestMessage = latest.first();
    if (
      !latestMessage ||
      latestMessage.author.id === process.env.BOT_ID ||
      (await OllamaService.getInstance().hasProcessedLatestMessage(latestMessage.id))
    ) {
      return;
    }

    const messages = await channel.messages.fetch({ limit: messageLimit() });
    const sortedMessages = Array.from(messages.values()).reverse();
    await this.processMessages(channel, sortedMessages, 'autonomous_tick');
  }

  private async processMessages(
    channel: TextChannel,
    messages: Message<boolean>[],
    trigger: string,
  ): Promise<void> {
    const ollamaService = OllamaService.getInstance();

    if (ollamaService.getIsThinking()) {
      return;
    }

    await channel.sendTyping().catch((error) => {
      console.warn('Failed to send typing indicator:', error);
    });

    const reply = await ollamaService.processFromChat(
      messages,
      channel.guild.emojis.cache.map((e) => e).filter((e) => !e.animated),
      channel.guild.members.cache.map((m) => m).filter((m) => !m.user.bot),
      trigger,
      (action) => this.executeAction(channel, messages, action),
    );

    if (!reply) {
      return;
    }

    if (!reply.response) {
      return;
    }

    if (this.isRepeatedBotMessage(messages, reply.response)) {
      console.warn('Skipped repeated bot response');
      return;
    }

    const sent = await channel.send(reply.response);
    await ollamaService.recordDiscordMessage(sent, trigger);
  }

  private isRepeatedBotMessage(messages: Message<boolean>[], response: string): boolean {
    const responseText = this.normalizeText(response);

    return messages.some(
      (message) =>
        message.author.id === process.env.BOT_ID &&
        this.normalizeText(message.content) === responseText,
    );
  }

  private normalizeText(text: string): string {
    return text.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  private async executeAction(
    channel: TextChannel,
    messages: Message<boolean>[],
    action: DiscordAction,
  ): Promise<unknown> {
    if (action.type === 'reply_to_message' && action.messageId && action.content) {
      const target =
        messages.find((msg) => msg.id === action.messageId) ??
        (await channel.messages.fetch(action.messageId));
      await target.reply(action.content);
      return { tool: 'reply_to_message', ok: true };
    }

    if (action.type === 'add_reaction' && action.messageId && action.emoji) {
      const emoji = this.validReactionEmoji(channel, action.emoji);
      if (!emoji) {
        return {
          tool: 'add_reaction',
          ok: false,
          error:
            'Invalid emoji. Use an exact available custom emoji like <:name:id> or a real Unicode emoji like 💀, not :skull: or skull.',
        };
      }

      const target = await this.fetchMessage(channel, messages, action.messageId);
      await target.react(emoji);
      return { tool: 'add_reaction', ok: true };
    }

    if (action.type === 'change_nickname' && action.nickname) {
      await channel.guild.members.me?.setNickname(action.nickname);
      return { tool: 'change_nickname', ok: true };
    }

    return { tool: action.type, ok: false, error: 'Invalid action arguments' };
  }

  private validReactionEmoji(channel: TextChannel, emoji: string): string | undefined {
    const value = emoji.trim();
    const custom = /^<(a?):([A-Za-z0-9_]+):(\d+)>$/.exec(value);
    if (custom) {
      const [, animated, name, id] = custom;
      const guildEmoji = channel.guild.emojis.cache.get(id ?? '');
      if (!guildEmoji) {
        return undefined;
      }

      return guildEmoji?.name === name && (animated === 'a') === guildEmoji.animated
        ? `<${guildEmoji.animated ? 'a' : ''}:${guildEmoji.name}:${guildEmoji.id}>`
        : undefined;
    }

    return this.isUnicodeEmoji(value) ? value : undefined;
  }

  private isUnicodeEmoji(value: string): boolean {
    return (
      /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\uFE0F|\u200D|[0-9#*]\uFE0F?\u20E3)+$/u.test(
        value,
      ) && /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u.test(value)
    );
  }

  private async fetchMessage(
    channel: TextChannel,
    messages: Message<boolean>[],
    messageId: string,
  ): Promise<Message> {
    return (
      messages.find((msg) => msg.id === messageId) ?? (await channel.messages.fetch(messageId))
    );
  }
}
