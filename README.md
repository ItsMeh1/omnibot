# OmniBot

**Discord, anywhere.** OmniBot is a Discord bot + realtime web client that mirrors channels into an embeddable website.

## Architecture

```text
Discord Gateway
      │
      ▼
Cloudflare Durable Object
      │ WebSocket
      ▼
Cloudflare Worker
      │
      ├── REST API
      └── WebSocket
             │
             ▼
      GitHub Pages client
             │
             ▼
          iframe
```

GitHub Pages is only the frontend. Your computer is **not** the host and does not need to stay online.

## Discord setup

1. Create an application in the Discord Developer Portal.
2. Add a bot.
3. Enable **Message Content Intent** under Bot → Privileged Gateway Intents.
4. Invite the bot to a test server with the `bot` scope (and `applications.commands` if you want slash commands later).
5. Give it at least **View Channels** and **Read Message History** for channels you want mirrored. Add **Send Messages** only if you later enable web-to-Discord posting.
6. Copy the bot token and Application ID. Never put the bot token in GitHub or browser JavaScript.

## Cloudflare deployment

You can deploy from your GitHub repository; you do not need a VPS or a computer running 24/7.

### Required Worker secrets

Create these in **Cloudflare Dashboard → Workers & Pages → OmniBot → Settings → Variables and Secrets**:

- `DISCORD_TOKEN` — your bot token, as a Secret.
- `DISCORD_CLIENT_ID` — your Discord Application ID, as a Secret or normal variable.

Optional:

- `WRITE_API_KEY` — server-side key that enables the protected POST endpoint. Do not put this key in a public website. For a real public multi-user write experience, use Discord OAuth instead.

### Deploy with Wrangler

If you use the CLI:

```bash
npm install
npx wrangler login
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put DISCORD_CLIENT_ID
npm run deploy
```

`wrangler.toml` already declares the `BOT_BRIDGE` Durable Object and its SQLite migration.

If Cloudflare reports a Durable Object migration/binding error, **stop there** and fix the configuration instead of creating a second Worker or changing random settings.

## GitHub Pages

The Pages frontend is at the repository root:

- `index.html` — landing page
- `app.html` — full web client
- `embed.html` — iframe client
- `app.js` — client logic
- `styles.css` — UI
- `config.js` — public Worker URL only

After the Worker is deployed, edit `config.js`:

```js
window.OMNIBOT_API = 'https://YOUR-WORKER.workers.dev';
```

Then enable GitHub Pages from the `main` branch and `/ (root)`.

## Embed

Once the Worker and Pages site are configured:

```html
<iframe
  src="https://itsmeh1.github.io/omnibot/embed.html?guild=GUILD_ID&channel=CHANNEL_ID"
  width="100%"
  height="600"
  style="border:0;border-radius:16px;overflow:hidden"
  loading="lazy"
  title="OmniBot">
</iframe>
```

Because the embed is a normal static page using a public Worker endpoint, the containing website does not need Node.js or its own backend.

## What works

- Discord Gateway connection
- Guild discovery from the bot's Gateway `READY` state
- Text channel discovery through the bot token
- Recent message history
- Live message create/update/delete events
- Message attachments
- Responsive Discord-style client
- Read-only iframe embeds
- Automatic Gateway reconnect attempts
- Public landing/invite page

## Current limitation

Web-to-Discord posting is deliberately **not public by default**. A shared API key is not safe to expose inside a public iframe because visitors could extract it.

The correct next step for public posting is **Discord OAuth2 + per-user authorization**. That can let OmniBot determine who the visitor is and what servers/channels they are allowed to interact with.

## Important reality check

This project is more complicated than a normal static GitHub Pages site. The frontend is static, but the bot needs a persistent/reliable Discord Gateway connection and stateful realtime WebSockets. Cloudflare is providing that server-side runtime; GitHub Pages cannot run the Discord bot itself.
