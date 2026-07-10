import consoleStamp from 'console-stamp';
import chalk from 'chalk';
import { Client, Events, GatewayIntentBits, TextChannel } from 'discord.js';
import MessageCreateEvent from './events/message-create.event.js';

consoleStamp.default(console, {
  format: ':prefix() :label(7).red',
  tokens: {
    prefix: () => `[${chalk.blue('RAMP-AI')}]`,
  },
});

process.loadEnvFile('.env');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const messageCreateHandler = new MessageCreateEvent(client);
const botMessageIntervalMs = Number(process.env.BOT_MESSAGE_INTERVAL_MS ?? 900000);

client.on(Events.MessageCreate, (message) => {
  messageCreateHandler
    .handle(message)
    .then()
    .catch((error) => {
      console.error('Error handling message create event:', error);
    });
});

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user?.tag ?? client.user?.id ?? 'unknown bot'}`);

  if (botMessageIntervalMs <= 0) {
    return;
  }

  setInterval(() => {
    client.channels
      .fetch(process.env.DISCORD_CHANNEL_ID ?? '')
      .then(async (channel) => {
        if (!(channel instanceof TextChannel)) {
          return;
        }

        await messageCreateHandler.tick(channel);
      })
      .catch((error) => {
        console.error('Error handling scheduled bot message:', error);
      });
  }, botMessageIntervalMs);
});

client.on(Events.Error, (error) => {
  console.error('Discord client error:', error);
});

client
  .login(process.env.DISCORD_API_TOKEN)
  .then()
  .catch((error) => {
    console.error('Error logging in:', error);
  });
