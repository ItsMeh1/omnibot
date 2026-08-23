import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { Server } from 'socket.io';
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials
} from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID || null;
const WRITE_API_KEY = process.env.WRITE_API_KEY || null;
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and add your bot token.');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const corsOrigin = allowedOrigins.length ? allowedOrigins : true;

const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'] }
});

app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '128kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

function isAllowedGuild(guildId) {
  return !GUILD_ID || guildId === GUILD_ID;
}

function serializeUser(user) {
  return {
    id: user.id,
    username: user.username,
    globalName: user.globalName,
    avatar: user.displayAvatarURL({ size: 128, extension: 'png' }),
    bot: user.bot
  };
}

function serializeMessage(message) {
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    content: message.content,
    createdAt: message.createdTimestamp,
    editedAt: message.editedTimestamp,
    author: serializeUser(message.author),
    attachments: [...message.attachments.values()].map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      url: attachment.url,
      contentType: attachment.contentType,
      size: attachment.size,
      width: attachment.width,
      height: attachment.height
    }))
  };
}

function getGuilds() {
  return [...client.guilds.cache.values()]
    .filter((guild) => isAllowedGuild(guild.id))
    .map((guild) => ({ id: guild.id, name: guild.name, icon: guild.iconURL({ size: 128, extension: 'png' }) }));
}

async function getChannels(guildId) {
  if (!isAllowedGuild(guildId)) return [];
  const guild = await client.guilds.fetch(guildId);
  const channels = await guild.channels.fetch();
  return [...channels.values()]
    .filter((channel) => channel && channel.type === ChannelType.GuildText)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: 'text',
      position: channel.rawPosition,
      categoryId: channel.parentId
    }));
}

async function getMessages(channelId, limit = 50) {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased() || !channel.guild || !isAllowedGuild(channel.guild.id)) {
    throw new Error('Channel is unavailable.');
  }
  const messages = await channel.messages.fetch({ limit: Math.min(Math.max(Number(limit) || 50, 1), 100) });
  return [...messages.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map(serializeMessage);
}

function authorizeWrite(req) {
  if (!WRITE_API_KEY) return true;
  return req.get('x-omnibot-key') === WRITE_API_KEY;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, discordReady: client.isReady(), bot: client.user ? serializeUser(client.user) : null });
});

app.get('/api/guilds', (req, res) => res.json(getGuilds()));

app.get('/api/guilds/:guildId/channels', async (req, res, next) => {
  try {
    res.json(await getChannels(req.params.guildId));
  } catch (error) { next(error); }
});

app.get('/api/channels/:channelId/messages', async (req, res, next) => {
  try {
    res.json(await getMessages(req.params.channelId, req.query.limit));
  } catch (error) { next(error); }
});

app.post('/api/channels/:channelId/messages', async (req, res, next) => {
  try {
    if (!authorizeWrite(req)) return res.status(401).json({ error: 'Unauthorized' });
    const content = String(req.body?.content || '').trim();
    if (!content || content.length > 2000) {
      return res.status(400).json({ error: 'Message content must be between 1 and 2000 characters.' });
    }
    const channel = await client.channels.fetch(req.params.channelId);
    if (!channel?.isTextBased() || !channel.guild || !isAllowedGuild(channel.guild.id)) {
      return res.status(404).json({ error: 'Channel unavailable.' });
    }
    const message = await channel.send({ content, allowedMentions: { parse: [] } });
    res.status(201).json(serializeMessage(message));
  } catch (error) { next(error); }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: error.message || 'Internal server error.' });
});

io.on('connection', (socket) => {
  socket.on('subscribe', async ({ guildId, channelId } = {}) => {
    try {
      if (!guildId || !channelId || !isAllowedGuild(guildId)) throw new Error('Invalid subscription.');
      socket.join(`channel:${channelId}`);
      socket.emit('subscribed', { guildId, channelId });
    } catch (error) {
      socket.emit('omnibot:error', { message: error.message });
    }
  });
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`OmniBot online as ${readyClient.user.tag}`);
});

client.on(Events.MessageCreate, (message) => {
  if (!message.guildId || !isAllowedGuild(message.guildId)) return;
  io.to(`channel:${message.channelId}`).emit('message:create', serializeMessage(message));
});

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  try {
    if (newMessage.partial) await newMessage.fetch();
    if (!newMessage.guildId || !isAllowedGuild(newMessage.guildId)) return;
    io.to(`channel:${newMessage.channelId}`).emit('message:update', serializeMessage(newMessage));
  } catch (error) {
    console.warn('Unable to process message update:', error.message);
  }
});

client.on(Events.MessageDelete, (message) => {
  if (!message.guildId || !isAllowedGuild(message.guildId)) return;
  io.to(`channel:${message.channelId}`).emit('message:delete', { id: message.id, channelId: message.channelId });
});

client.login(DISCORD_TOKEN);
server.listen(PORT, () => console.log(`OmniBot web bridge listening on http://localhost:${PORT}`));
