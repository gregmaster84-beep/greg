'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DEFAULT_ROOMS = ['Lobby', 'Music', 'Games', 'Movies', 'Tech Talk'];
const MAX_HISTORY = 50; // messages remembered per room (in memory)
const MAX_TEXT = 500; // characters per message
const MAX_ROOMS_PER_USER = 10;
const STATUSES = ['online', 'busy', 'away'];
const NAME_RE = /^[A-Za-z0-9_\-. ]+$/;

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10 * 1024 });

// ---- In-memory state (single instance; see README for scaling) ------------
const users = new Map(); // socket.id -> { id, nick, status, message }
const nicks = new Map(); // lowercase nick -> socket.id
const members = new Map(); // room name -> Set(socket.id)
const history = new Map(); // room name -> [message]
for (const r of DEFAULT_ROOMS) {
  members.set(r, new Set());
  history.set(r, []);
}

// ---- Helpers --------------------------------------------------------------
function clean(value, max, re) {
  if (typeof value !== 'string') return null;
  const s = value.replace(/\s+/g, ' ').trim();
  if (!s || s.length > max || (re && !re.test(s))) return null;
  return s;
}

function cleanText(value) {
  if (typeof value !== 'string') return null;
  const s = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return s ? s.slice(0, MAX_TEXT) : null;
}

// Sliding-window rate limiter, per socket and per action.
function allow(socket, key, max, windowMs) {
  const now = Date.now();
  const buckets = (socket.data.buckets = socket.data.buckets || {});
  const recent = (buckets[key] = (buckets[key] || []).filter((t) => now - t < windowMs));
  if (recent.length >= max) return false;
  recent.push(now);
  return true;
}

function resolveRoom(raw) {
  const name = clean(raw, 24, NAME_RE);
  if (!name) return null;
  for (const existing of members.keys()) {
    if (existing.toLowerCase() === name.toLowerCase()) return existing;
  }
  return name;
}

const publicUser = (u) => ({ nick: u.nick, status: u.status, message: u.message });
const roomsSnapshot = () => [...members.entries()].map(([name, set]) => ({ name, count: set.size }));
const roomsOf = (id) => [...members.entries()].filter(([, set]) => set.has(id)).map(([name]) => name);

function broadcastUsers() {
  io.emit('users', [...users.values()].map(publicUser));
}

function broadcastRooms() {
  io.emit('rooms', roomsSnapshot());
}

function broadcastMembers(room) {
  const set = members.get(room);
  if (!set) return;
  const list = [...set]
    .map((id) => users.get(id) && users.get(id).nick)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  io.to('room:' + room).emit('room:members', { room, members: list });
}

function roomEvent(room, text) {
  io.to('room:' + room).emit('room:event', { room, text, ts: Date.now() });
}

function joinRoom(socket, room) {
  const user = users.get(socket.id);
  if (!members.has(room)) {
    members.set(room, new Set());
    history.set(room, []);
  }
  const set = members.get(room);
  if (set.has(socket.id)) return;
  set.add(socket.id);
  socket.join('room:' + room);
  socket.emit('room:history', { room, messages: history.get(room) });
  roomEvent(room, `${user.nick} has entered the room.`);
  broadcastMembers(room);
  broadcastRooms();
}

// Remove a user from a room's bookkeeping (works even if the socket is dead).
function dropFromRoom(id, room) {
  const set = members.get(room);
  if (!set || !set.delete(id)) return;
  const user = users.get(id);
  if (user) roomEvent(room, `${user.nick} has left the room.`);
  broadcastMembers(room);
  if (set.size === 0 && !DEFAULT_ROOMS.includes(room)) {
    members.delete(room);
    history.delete(room);
  }
  broadcastRooms();
}

function removeUser(id) {
  const user = users.get(id);
  if (!user) return;
  for (const room of [...members.keys()]) dropFromRoom(id, room);
  users.delete(id);
  if (nicks.get(user.nick.toLowerCase()) === id) nicks.delete(user.nick.toLowerCase());
  broadcastUsers();
}

// ---- Socket handlers ------------------------------------------------------
io.on('connection', (socket) => {
  const reply = (ack) => (typeof ack === 'function' ? ack : () => {});

  socket.on('login', (rawNick, ack) => {
    const done = reply(ack);
    if (users.has(socket.id)) return done({ ok: false, error: 'You are already signed in.' });

    const nick = clean(rawNick, 16, NAME_RE);
    if (!nick || nick.length < 2) {
      return done({ ok: false, error: 'Pick a nickname of 2-16 characters: letters, numbers, spaces, _ - or .' });
    }
    const key = nick.toLowerCase();
    const existingId = nicks.get(key);
    if (existingId) {
      const other = io.sockets.sockets.get(existingId);
      if (other && other.connected) {
        return done({ ok: false, error: `"${nick}" is already online. Try another nickname.` });
      }
      removeUser(existingId); // stale entry from a dropped connection
    }

    users.set(socket.id, { id: socket.id, nick, status: 'online', message: '' });
    nicks.set(key, socket.id);
    done({ ok: true, nick, users: [...users.values()].map(publicUser), rooms: roomsSnapshot() });
    joinRoom(socket, 'Lobby');
    broadcastUsers();
  });

  socket.on('room:join', (raw, ack) => {
    const done = reply(ack);
    const user = users.get(socket.id);
    if (!user) return done({ ok: false, error: 'Sign in first.' });
    const room = resolveRoom(raw);
    if (!room) return done({ ok: false, error: 'Room names are 1-24 characters: letters, numbers, spaces, _ - or .' });
    if (!allow(socket, 'join', 10, 10000)) return done({ ok: false, error: 'Slow down a little!' });
    if (!members.get(room) || !members.get(room).has(socket.id)) {
      if (roomsOf(socket.id).length >= MAX_ROOMS_PER_USER) {
        return done({ ok: false, error: `You can be in at most ${MAX_ROOMS_PER_USER} rooms.` });
      }
    }
    joinRoom(socket, room);
    done({ ok: true, room });
  });

  socket.on('room:leave', (room) => {
    if (!users.has(socket.id) || typeof room !== 'string') return;
    socket.leave('room:' + room);
    dropFromRoom(socket.id, room);
  });

  socket.on('msg:room', (p) => {
    const user = users.get(socket.id);
    if (!user || !p || typeof p.room !== 'string') return;
    const text = cleanText(p.text);
    const set = members.get(p.room);
    if (!text || !set || !set.has(socket.id)) return;
    if (!allow(socket, 'msg', 6, 3000)) return socket.emit('system', 'Slow down a little!');
    const msg = { room: p.room, nick: user.nick, text, ts: Date.now() };
    const log = history.get(p.room);
    log.push(msg);
    if (log.length > MAX_HISTORY) log.shift();
    io.to('room:' + p.room).emit('msg:room', msg);
  });

  socket.on('msg:dm', (p, ack) => {
    const done = reply(ack);
    const user = users.get(socket.id);
    if (!user || !p) return done({ ok: false, error: 'Sign in first.' });
    const text = cleanText(p.text);
    const toNick = clean(p.to, 16, NAME_RE);
    if (!text || !toNick) return done({ ok: false, error: 'Message not sent.' });
    const targetId = nicks.get(toNick.toLowerCase());
    const target = targetId && users.get(targetId);
    if (!target) return done({ ok: false, error: `${toNick} is not online.` });
    if (target.id === socket.id) return done({ ok: false, error: "You can't message yourself." });
    if (!allow(socket, 'msg', 6, 3000)) return done({ ok: false, error: 'Slow down a little!' });
    const msg = { from: user.nick, to: target.nick, text, ts: Date.now() };
    io.to(target.id).emit('msg:dm', msg);
    socket.emit('msg:dm', msg); // echo so both sides render the same line
    done({ ok: true });
  });

  socket.on('typing', (p) => {
    const user = users.get(socket.id);
    if (!user || !p || !allow(socket, 'typing', 20, 5000)) return;
    const typing = !!p.typing;
    if (typeof p.room === 'string') {
      const set = members.get(p.room);
      if (set && set.has(socket.id)) {
        socket.to('room:' + p.room).emit('typing', { room: p.room, nick: user.nick, typing });
      }
    } else if (typeof p.to === 'string') {
      const id = nicks.get(p.to.toLowerCase());
      if (id && id !== socket.id) io.to(id).emit('typing', { dm: user.nick, nick: user.nick, typing });
    }
  });

  socket.on('nudge', (p, ack) => {
    const done = reply(ack);
    const user = users.get(socket.id);
    if (!user || !p || typeof p.to !== 'string') return done({ ok: false, error: 'Nudge failed.' });
    const id = nicks.get(p.to.toLowerCase());
    if (!id || id === socket.id || !users.has(id)) return done({ ok: false, error: `${p.to} is not online.` });
    if (!allow(socket, 'nudge', 1, 5000)) return done({ ok: false, error: 'Easy on the nudges!' });
    io.to(id).emit('nudge', { from: user.nick });
    done({ ok: true });
  });

  socket.on('status', (p) => {
    const user = users.get(socket.id);
    if (!user || !p || !allow(socket, 'status', 10, 10000)) return;
    if (STATUSES.includes(p.status)) user.status = p.status;
    user.message = typeof p.message === 'string' ? p.message.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    broadcastUsers();
  });

  socket.on('disconnect', () => removeUser(socket.id));
});

server.listen(PORT, () => {
  console.log(`Retro Messenger is running on http://localhost:${PORT}`);
});
