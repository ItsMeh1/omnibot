const DISCORD_API = 'https://discord.com/api/v10';
const GATEWAY_VERSION = 10;
const INTENTS = 1 | 512 | 32768; // GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/api/config') {
      const clientId = env.DISCORD_CLIENT_ID || '';
      return json({
        clientId,
        inviteUrl: clientId
          ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&scope=bot%20applications.commands&permissions=3072`
          : ''
      }, 200, cors);
    }

    const bridge = getBridge(env);
    if (url.pathname === '/api/health') return withCors(await bridge.fetch(internal('/health')), cors);
    if (url.pathname === '/api/guilds') return withCors(await bridge.fetch(internal('/guilds')), cors);

    const channels = url.pathname.match(/^\/api\/guilds\/([^/]+)\/channels$/);
    if (channels && request.method === 'GET') {
      const guildId = channels[1];
      const known = await bridge.fetch(internal(`/guild/${guildId}/known`));
      if (known.status !== 200) return withCors(known, cors);
      const response = await discord(env, `/guilds/${guildId}/channels`);
      if (!response.ok) return discordError(response, cors);
      const data = await response.json();
      return json(data.filter(c => c.type === 0).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map(c => ({ id: c.id, name: c.name, position: c.position, categoryId: c.parent_id })), 200, cors);
    }

    const messages = url.pathname.match(/^\/api\/channels\/([^/]+)\/messages$/);
    if (messages && request.method === 'GET') {
      const response = await discord(env, `/channels/${messages[1]}/messages?limit=100`);
      if (!response.ok) return discordError(response, cors);
      return json((await response.json()).reverse().map(pack), 200, cors);
    }

    if (messages && request.method === 'POST') {
      // Posting is deliberately disabled until an authentication mechanism is configured.
      // A shared browser-visible key is not suitable for a public multi-user widget.
      if (!env.WRITE_API_KEY || request.headers.get('x-omnibot-key') !== env.WRITE_API_KEY) return json({ error: 'Web posting is disabled. Configure WRITE_API_KEY and keep it server-side, or add Discord OAuth before enabling public posting.' }, 403, cors);
      const body = await request.json().catch(() => ({}));
      const content = String(body.content || '').trim();
      if (!content || content.length > 2000) return json({ error: 'Message must be 1-2000 characters.' }, 400, cors);
      const response = await discord(env, `/channels/${messages[1]}/messages`, { method: 'POST', body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
      if (!response.ok) return discordError(response, cors);
      return json(pack(await response.json()), 201, cors);
    }

    if (url.pathname === '/ws') return bridge.fetch(request);
    return new Response('OmniBot Worker online', { headers: { ...cors, 'content-type': 'text/plain' } });
  }
};

function getBridge(env) { return env.BOT_BRIDGE.get(env.BOT_BRIDGE.idFromName('global')); }
function internal(path) { return new Request(`https://omnibot.internal${path}`); }
async function discord(env, path, options = {}) { return fetch(DISCORD_API + path, { ...options, headers: { authorization: `Bot ${env.DISCORD_TOKEN}`, 'content-type': 'application/json', ...(options.headers || {}) } }); }
const user = u => ({ id: u?.id, username: u?.username, globalName: u?.global_name || u?.username, avatar: u?.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128` : null, bot: !!u?.bot });
const pack = m => ({ id: m.id, channelId: m.channel_id, guildId: m.guild_id || null, content: m.content || '', createdAt: Date.parse(m.timestamp), editedAt: m.edited_timestamp ? Date.parse(m.edited_timestamp) : null, author: user(m.author), attachments: (m.attachments || []).map(a => ({ id: a.id, name: a.filename, url: a.url, contentType: a.content_type || null, size: a.size, width: a.width, height: a.height })) });
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
async function discordError(response, headers) { const text = await response.text(); let message = text; try { message = JSON.parse(text).message || text; } catch {} return json({ error: message || `Discord ${response.status}` }, response.status, headers); }
function corsHeaders(request, env) { const origin = request.headers.get('Origin') || ''; const allowed = env.ALLOWED_ORIGIN || '*'; return { 'access-control-allow-origin': allowed === '*' ? '*' : (origin === allowed ? origin : allowed), 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'Content-Type,x-omnibot-key', 'access-control-allow-credentials': allowed === '*' ? 'false' : 'true', 'cache-control': 'no-store', vary: 'Origin' }; }
function withCors(response, headers) { const next = new Headers(response.headers); for (const [key, value] of Object.entries(headers)) next.set(key, value); return new Response(response.body, { status: response.status, headers: next }); }

export class BotBridge {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.gateway = null; this.clients = new Map(); this.guilds = new Map(); this.seq = null; this.heartbeat = null; this.reconnectTimer = null; this.starting = false; this.sessionId = null; this.resumeUrl = null; }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, gatewayConnected: !!this.gateway, browserClients: this.clients.size, guilds: this.guilds.size });
    if (url.pathname === '/guilds') return json([...this.guilds.values()]);
    const known = url.pathname.match(/^\/guild\/([^/]+)\/known$/);
    if (known) return this.guilds.has(known[1]) ? json({ ok: true }) : json({ error: 'The bot is not connected to this server.' }, 404);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') { this.ensureGateway(); return new Response('WebSocket required', { status: 426 }); }

    const pair = new WebSocketPair();
    const client = pair[0], socket = pair[1];
    socket.accept();
    const id = crypto.randomUUID();
    this.clients.set(id, { socket, channelId: null, guildId: null });
    socket.addEventListener('message', event => this.browserMessage(id, event.data));
    socket.addEventListener('close', () => this.clients.delete(id));
    socket.addEventListener('error', () => this.clients.delete(id));
    safe(socket, { type: 'status', gatewayConnected: !!this.gateway, guildCount: this.guilds.size });
    this.ensureGateway();
    return new Response(null, { status: 101, webSocket: client });
  }
  async browserMessage(id, raw) { try { const message = JSON.parse(raw), client = this.clients.get(id); if (!client) return; if (message.type === 'subscribe') { client.guildId = String(message.guildId || ''); client.channelId = String(message.channelId || ''); safe(client.socket, { type: 'subscribed', guildId: client.guildId, channelId: client.channelId }); } } catch {} }
  ensureGateway() { if (this.gateway || this.starting || !this.env.DISCORD_TOKEN) return; this.starting = true; this.ctx.waitUntil(this.connectGateway()); }
  async connectGateway() {
    try {
      const discovery = await fetch(`${DISCORD_API}/gateway/bot`, { headers: { authorization: `Bot ${this.env.DISCORD_TOKEN}` } });
      if (!discovery.ok) throw new Error(`Gateway discovery failed (${discovery.status})`);
      const info = await discovery.json();
      this.resumeUrl = info.url;
      const ws = await fetch(`${info.url}?v=${GATEWAY_VERSION}&encoding=json`, { headers: { Upgrade: 'websocket' } });
      if (!ws.webSocket) throw new Error('Cloudflare did not create the outbound Gateway WebSocket');
      this.gateway = ws.webSocket;
      this.gateway.accept();
      this.gateway.addEventListener('message', event => this.gatewayMessage(event.data));
      this.gateway.addEventListener('close', () => this.gatewayClosed());
      this.gateway.addEventListener('error', () => this.gatewayClosed());
    } catch (error) { console.error('[OmniBot Gateway]', error); this.gateway = null; this.scheduleReconnect(5000); }
    finally { this.starting = false; }
  }
  gatewayMessage(raw) {
    let payload; try { payload = JSON.parse(raw); } catch { return; }
    if (payload.s !== null && payload.s !== undefined) this.seq = payload.s;
    if (payload.op === 10) { this.startHeartbeat(payload.d.heartbeat_interval); if (this.sessionId && this.resumeUrl) this.send(6, { token: this.env.DISCORD_TOKEN, session_id: this.sessionId, seq: this.seq }); else this.send(2, { token: this.env.DISCORD_TOKEN, intents: INTENTS, properties: { os: 'linux', browser: 'omnibot', device: 'omnibot' } }); return; }
    if (payload.op === 11) return;
    if (payload.op === 1) return this.send(1, this.seq);
    if (payload.op === 7) return this.reconnectGateway();
    if (payload.op === 9) { this.sessionId = null; this.seq = null; return this.reconnectGateway(); }
    if (payload.op === 0) this.dispatch(payload.t, payload.d);
  }
  dispatch(type, data) {
    if (type === 'READY') { this.sessionId = data.session_id; this.resumeUrl = data.resume_gateway_url || this.resumeUrl; this.guilds.clear(); for (const guild of data.guilds || []) this.guilds.set(guild.id, { id: guild.id, name: guild.name, icon: guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128` : null }); this.broadcast({ type: 'status', gatewayConnected: true, guildCount: this.guilds.size }); this.broadcast({ type: 'guilds', data: [...this.guilds.values()] }); return; }
    if (type === 'GUILD_CREATE') { this.guilds.set(data.id, { id: data.id, name: data.name, icon: data.icon ? `https://cdn.discordapp.com/icons/${data.id}/${data.icon}.png?size=128` : null }); this.broadcast({ type: 'guilds', data: [...this.guilds.values()] }); return; }
    if (type === 'GUILD_DELETE') { this.guilds.delete(data.id); this.broadcast({ type: 'guilds', data: [...this.guilds.values()] }); return; }
    if (type === 'MESSAGE_CREATE') return this.message('message:create', data);
    if (type === 'MESSAGE_UPDATE') return this.message('message:update', data);
    if (type === 'MESSAGE_DELETE') return this.message('message:delete', data);
  }
  message(type, data) { const payload = type === 'message:delete' ? { id: data.id, channelId: data.channel_id } : pack(data); for (const client of this.clients.values()) if (client.channelId === data.channel_id) safe(client.socket, { type, data: payload }); }
  startHeartbeat(interval) { if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = setInterval(() => { if (this.gateway) this.send(1, this.seq); }, Math.max(Number(interval) || 41250, 5000)); }
  send(op, data) { try { this.gateway?.send(JSON.stringify({ op, d: data })); } catch { this.gatewayClosed(); } }
  reconnectGateway() { try { this.gateway?.close(1000, 'reconnect'); } catch {} this.gatewayClosed(); }
  gatewayClosed() { this.gateway = null; if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null; this.broadcast({ type: 'status', gatewayConnected: false }); this.scheduleReconnect(5000); }
  scheduleReconnect(delay) { if (this.reconnectTimer) return; this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.ensureGateway(); }, delay); }
  broadcast(payload) { for (const client of this.clients.values()) safe(client.socket, payload); }
}
const safe = (socket, payload) => { try { socket.send(JSON.stringify(payload)); } catch {} };
