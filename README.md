# OmniBot

OmniBot is a lightweight Discord-to-web bridge. A Discord bot listens for messages and updates an embeddable Discord-style web client in real time.

## What it does

- Mirrors messages from Discord text channels to the web client.
- Receives new messages, edits, and deletions live through Socket.IO.
- Shows servers and text channels the bot can access.
- Loads recent channel history when a channel is opened.
- Supports posting back to Discord from the web client.
- Handles attachments and basic responsive layouts.
- Can be embedded with an iframe.
- Can be restricted to one Discord server with `DISCORD_GUILD_ID`.

## Important Discord setup

This is **not just a webhook**. Discord webhooks can post messages, but they do not provide a stream of every server message. OmniBot uses a Discord bot connected to the Gateway.

Create an application and bot in the Discord Developer Portal, then enable the intents needed by the app:

- **Guilds**
- **Guild Messages**
- **Message Content** — required if you want ordinary message text mirrored

Invite the bot to the server with permission to view the channels you want exposed and to send messages if you want web-to-Discord posting.

## Run locally

```bash
git clone https://github.com/ItsMeh1/omnibot.git
cd omnibot
npm install
cp .env.example .env
```

Put your bot token into `.env`:

```env
DISCORD_TOKEN=your_bot_token
DISCORD_GUILD_ID=optional_server_id
PORT=3000
```

Then run:

```bash
npm start
```

Open `http://localhost:3000`.

## Embed it

Once deployed, the client is simply the root page, so you can embed it like this:

```html
<iframe
  src="https://your-omnibot-domain.example/"
  width="100%"
  height="650"
  style="border:0;border-radius:12px;overflow:hidden"
  title="Discord chat">
</iframe>
```

## API

### `GET /api/health`
Returns bridge and Discord connection status.

### `GET /api/guilds`
Lists Discord servers available to the bot, respecting `DISCORD_GUILD_ID` when configured.

### `GET /api/guilds/:guildId/channels`
Lists accessible text channels.

### `GET /api/channels/:channelId/messages?limit=50`
Returns recent messages.

### `POST /api/channels/:channelId/messages`
Posts a message through the bot.

```json
{ "content": "Hello from OmniBot" }
```

If `WRITE_API_KEY` is configured, send it as:

```http
X-OmniBot-Key: your-key
```

## Architecture

```text
Discord Gateway
      │
      ▼
  OmniBot server
   ├── REST API ────── browser history/server/channel data
   └── Socket.IO ───── live creates/edits/deletes
                         │
                         ▼
                  iframe-friendly UI
                         │
                         ▼
                    POST message
                         │
                         ▼
                    Discord channel
```

## Security note

Do **not** put the Discord bot token in browser JavaScript or commit `.env`. If this is deployed publicly, configure `ALLOWED_ORIGINS` and `WRITE_API_KEY` before exposing write access.
