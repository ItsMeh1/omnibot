# OmniBot

A public Discord-style web client powered by a Discord bot, Cloudflare Workers + Durable Objects, and GitHub Pages.

## Architecture

- **GitHub Pages** serves the public landing page, full client, and iframe embed.
- **Cloudflare Worker** proxies Discord REST API calls.
- **Durable Object** maintains one stateful Discord Gateway connection and broadcasts live message events to browser WebSockets.

## Deploy

### 1. Discord

Create a Discord application and bot. Enable **Message Content Intent** so ordinary message text can be mirrored. Invite the bot with the `bot` and `applications.commands` scopes and only the permissions it needs.

### 2. Cloudflare

```bash
npm install
npx wrangler login
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put DISCORD_CLIENT_ID
npm run deploy
```

`WRITE_API_KEY` is optional and protects browser-to-Discord posting if enabled:

```bash
npx wrangler secret put WRITE_API_KEY
```

### 3. GitHub Pages

After deployment, edit `config.js`:

```js
window.OMNIBOT_API = 'https://YOUR-WORKER.workers.dev';
```

Enable GitHub Pages from the `main` branch and repository root.

## Embed

```html
<iframe
  src="https://itsmeh1.github.io/omnibot/public/embed.html?guild=GUILD_ID&channel=CHANNEL_ID"
  width="100%"
  height="600"
  frameborder="0">
</iframe>
```

## Security

Never expose `DISCORD_TOKEN` in GitHub Pages or browser JavaScript. The bot can only mirror servers and channels where it is installed and has permission to view messages.

The current write API is intentionally optional. For a truly public multi-user posting feature, the next step should be Discord OAuth or another authentication system instead of exposing a shared API key.