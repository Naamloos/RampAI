import consoleStamp from 'console-stamp';
import chalk from 'chalk';
import {
  Client,
  ContainerBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  TextChannel,
  TextDisplayBuilder,
} from 'discord.js';
import MessageCreateEvent from './events/message-create.event.js';

consoleStamp.default(console, {
  format: ':prefix() :label(7).red',
  tokens: {
    prefix: () => `[${chalk.blue('RAMP-AI')}]`,
  },
});

process.loadEnvFile('.env');

for (const name of ['DISCORD_API_TOKEN', 'DISCORD_CHANNEL_ID']) {
  if (!process.env[name]?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}
const discordChannelId = process.env.DISCORD_CHANNEL_ID!;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessagePolls,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User],
});

const messageCreateHandler = new MessageCreateEvent(client);
const botMessageIntervalMs = Number(process.env.BOT_MESSAGE_INTERVAL_MS ?? 900000);
const reminderPollIntervalMs = Number(process.env.REMINDER_POLL_INTERVAL_MS ?? 30000);

function report(label: string, operation: Promise<unknown>): void {
  operation.catch((error) => console.error(label, error));
}

client.on(Events.MessageCreate, (message) => {
  report('Error handling message create event:', messageCreateHandler.handle(message));
});

client.on(Events.MessageUpdate, (_oldMessage, newMessage) => {
  report('Error handling message update:', messageCreateHandler.handleUpdate(newMessage));
});

client.on(Events.MessageDelete, (message) => {
  report('Error handling message deletion:', messageCreateHandler.handleDelete(message));
});

client.on(Events.MessageReactionAdd, (reaction, user) => {
  report(
    'Error handling reaction addition:',
    messageCreateHandler.handleReaction(reaction, user, true),
  );
});

client.on(Events.MessageReactionRemove, (reaction, user) => {
  report(
    'Error handling reaction removal:',
    messageCreateHandler.handleReaction(reaction, user, false),
  );
});

client.on(Events.MessagePollVoteAdd, (answer, userId) => {
  report('Error handling poll vote:', messageCreateHandler.handlePollVote(answer, userId, true));
});

client.on(Events.MessagePollVoteRemove, (answer, userId) => {
  report(
    'Error handling removed poll vote:',
    messageCreateHandler.handlePollVote(answer, userId, false),
  );
});

client.once(Events.ClientReady, () => {
  report('Error initializing bot:', initialize());
});

async function initialize(): Promise<void> {
  console.log(`Logged in as ${client.user?.tag ?? client.user?.id ?? 'unknown bot'}`);
  if (!client.user) {
    throw new Error('Discord client became ready without a user.');
  }
  process.env.BOT_ID = client.user.id;

  const channel = await client.channels.fetch(discordChannelId);
  if (!(channel instanceof TextChannel)) {
    throw new Error('DISCORD_CHANNEL_ID must identify a guild text channel visible to the bot.');
  }
  await channel.send({
    flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications,
    components: [
      new ContainerBuilder()
        .setAccentColor(0x5865f2)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('🟢 Bot online')),
    ],
    allowedMentions: { parse: [] },
  });
  await channel.guild.members
    .fetch({ withPresences: true })
    .catch((error) => console.warn('Failed to refresh guild members; using cache:', error));

  if (Number.isFinite(botMessageIntervalMs) && botMessageIntervalMs > 0) {
    setInterval(() => {
      report('Error handling scheduled bot activity:', messageCreateHandler.tick(channel));
    }, botMessageIntervalMs);
  }

  if (Number.isFinite(reminderPollIntervalMs) && reminderPollIntervalMs > 0) {
    setInterval(() => {
      report(
        'Error sending scheduled messages:',
        messageCreateHandler.flushScheduledMessages(channel),
      );
    }, reminderPollIntervalMs);
  }
}

client.on(Events.Error, (error) => {
  console.error('Discord client error:', error);
});

client
  .login(process.env.DISCORD_API_TOKEN)
  .then()
  .catch((error) => {
    console.error('Error logging in:', error);
  });
