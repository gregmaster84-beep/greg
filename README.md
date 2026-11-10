# Retro Messenger

A Yahoo Messenger-style chat service: nicknames, chat rooms, a friends list with
presence, private messages, typing indicators, nudges, emoticons and sounds.
Node.js + Express + Socket.IO on the server, plain HTML/CSS/JS in the browser.

## Run it on your computer

Requires Node.js 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000 in two browser windows, sign in with different
nicknames, and chat. Set `PORT` to use a different port (`PORT=8080 npm start`).

## Put it online

The server needs a host that keeps a Node process running and supports
WebSockets. Static-only hosts (GitHub Pages, Netlify static) will not work.

### Option A: Render (no credit card to start)

1. Push this folder to a GitHub repository.
2. In Render, choose **New > Blueprint** and select the repo. It reads
   `render.yaml` and sets everything up. (Or **New > Web Service** with build
   command `npm install` and start command `npm start`.)
3. When the deploy finishes you get an address like
   `https://retro-messenger.onrender.com`. Share it with friends.

On the free plan the service sleeps after about 15 idle minutes and takes around
a minute to wake up, and everything held in memory (online users, room history)
resets when it restarts.

### Option B: Railway or Fly.io

Both detect Node projects automatically (`npm install`, then `npm start`). Check
their current pricing and trial terms first; Fly.io asks for a credit card.

### Option C: Quick demo from your own computer

Run the app locally, then expose it with a tunnel:

```bash
ngrok http 3000
# or: cloudflared tunnel --url http://localhost:3000
```

The tool prints a public https address that works while your computer and the
tunnel are running.

## How to use the app

- **Sign in** with any nickname (2-16 characters). No password or account.
- **Rooms:** Lobby, Music, Games, Movies and Tech Talk exist by default. Type a
  new name under "Chat rooms" to create your own.
- **Private chat:** click anyone in "Online now" or in a room's member list.
- **Friends:** press **+** next to a name. Your friends list is saved in your
  browser and shows who is online. You get a chime when a friend signs in.
- **Nudge:** in a private chat, press Nudge to shake the other person's window.
- **Status:** choose Available, Busy or Away and add a short status message.
- The bell icon mutes sounds.

## Project layout

```
server.js          Socket.IO server: login, rooms, DMs, presence, rate limits
public/index.html  Page structure
public/style.css   Retro look
public/app.js      Browser client
render.yaml        One-click Render setup
```

## Limits and next steps

- All state lives in memory, so it works on a single server instance and resets
  on restart. For permanent history and accounts, add a database (PostgreSQL or
  SQLite) and password hashing (argon2 or bcrypt).
- To run on several servers, add the Socket.IO Redis adapter.
- Already in place: message length cap (500 characters), per-user rate limits,
  nickname and room-name validation, and message text is always inserted as plain
  text in the browser, so it cannot inject HTML.
- Before opening it to the public, consider moderation tools (block, report,
  ban), since anyone can pick any nickname.
