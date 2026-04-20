/**
 * Jam coordination server (Socket.IO). Standalone copy: live docs are in this directory — see README.md next to this file.
 */
import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { Server, Socket } from 'socket.io';
import cors from 'cors';

/** When `CORS_ORIGIN` is unset or `*`, all origins are allowed. Otherwise comma-separated HTTPS origins (e.g. `https://jam.valaki.in`). Requests with no `Origin` (many native apps) are allowed when a list is set. */
function isOriginAllowed(origin: string | undefined): boolean {
  const raw = process.env.CORS_ORIGIN?.trim();
  if (!raw || raw === '*') return true;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (origin === undefined || origin === '') return true;
  return list.includes(origin);
}

const app = express();

/** Numeric Apple App Store ID (e.g. from App Store Connect) — Smart App Banner, /join fallback URL, and optional AASA docs. */
const APPLE_APP_STORE_ID = process.env.APPLE_APP_STORE_ID?.trim() ?? '';
/** Apple Developer Team ID — required for Universal Links AASA `appID` (`{teamId}.{bundleId}`). */
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID?.trim() ?? '';
/** iOS bundle identifier (defaults to Sound Room). */
const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID?.trim() || 'com.valaki.soundroom';

app.use(
  cors({
    origin: (origin, callback) => callback(null, isOriginAllowed(origin)),
  })
);

/** Apple Universal Links — host this at https://jam.valaki.in/.well-known/apple-app-site-association (no redirects). Set APPLE_TEAM_ID (+ optional APPLE_BUNDLE_ID). */
app.get('/.well-known/apple-app-site-association', (_req, res) => {
  if (!APPLE_TEAM_ID) {
    res.status(404).type('text/plain').send('Apple Team ID not configured (set APPLE_TEAM_ID).');
    return;
  }
  const body = {
    applinks: {
      apps: [] as unknown[],
      details: [
        {
          appID: `${APPLE_TEAM_ID}.${APPLE_BUNDLE_ID}`,
          paths: ['/join', '/join/*'],
        },
      ],
    },
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(body);
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function joinErrorHtml(title: string, detail: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; color: #111; background: #fafafa; font-family: system-ui, sans-serif; }
    .box { text-align: center; padding-top: 50px; max-width: 28rem; margin: 0 auto; }
  </style>
</head>
<body>
  <div class="box">
    <h2>${escapeHtml(title)}</h2>
    <p>${escapeHtml(detail)}</p>
  </div>
</body>
</html>`;
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => callback(null, isOriginAllowed(origin)),
    methods: ['GET', 'POST'],
  },
  // Default 1e6 is too small for full jam queues with metadata; lean client payloads help too
  maxHttpBufferSize: 50 * 1024 * 1024,
});

interface User {
  id: string; // Socket ID
  username: string; // Navidrome username
  isHost: boolean;
  isReady: boolean;
  /** Guests only: `remote` = control host playback, no audio on this device (Spotify-style). */
  listenMode?: 'together' | 'remote';
}

interface Room {
  id: string;
  hostId: string;
  hostUsername: string;
  users: User[];
  playbackState: {
    isPlaying: boolean;
    currentTime: number;
    songId: string | null;
    queue: any[];
    queueIndex: number;
    updatedAt: number; // to calculate sync offsets
    repeatMode?: string;
  };
  permissions: {
    sharedControl: boolean; // if false, only host controls
  };
  subsonicInfo?: {
    url: string;
    user: string;
    salt: string;
    token: string;
  };
}

const rooms = new Map<string, Room>();
const roomTimeouts = new Map<string, NodeJS.Timeout>();

/** Room map keys are always UPPERCASE; client may send mixed case — must normalize or leave/join no-op. */
function normalizeRoomId(roomId: string | undefined | null): string | null {
  if (roomId == null || typeof roomId !== 'string') return null;
  const t = roomId.trim().toUpperCase();
  return t.length > 0 ? t : null;
}

/** Auto-generated jam codes: 8 base-36 chars (0–9, A–Z), uppercase. */
function generateRandomRoomId(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += alphabet[Math.floor(Math.random() * 36)];
  }
  return s.toUpperCase();
}

/**
 * Universal Link landing: `?id=` room code only. Host name and permissions come from the live room on this server (not from query params).
 * Deep link: `soundroom://jam?id=ROOM` (id only).
 */
app.get('/join', (req, res) => {
  const idRaw = req.query.id;
  const roomIdRaw =
    typeof idRaw === 'string'
      ? idRaw
      : Array.isArray(idRaw) && typeof idRaw[0] === 'string'
        ? idRaw[0]
        : '';
  const rid = normalizeRoomId(roomIdRaw);

  const appStoreUrl = APPLE_APP_STORE_ID
    ? `https://apps.apple.com/app/id${APPLE_APP_STORE_ID}`
    : 'https://apps.apple.com/';
  const playStoreUrl = 'https://play.google.com/store/apps/details?id=com.valaki.soundroom';

  if (!rid) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(400).send(joinErrorHtml('Invalid room code', 'Check the link and try again.'));
    return;
  }

  const room = rooms.get(rid);
  if (!room) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(404).send(
      joinErrorHtml('Session not found', 'This jam may have ended, or the code is wrong.')
    );
    return;
  }

  const hostLabel = escapeHtml(room.hostUsername);
  const roomIdJs = JSON.stringify(rid);
  const smartBannerMeta =
    APPLE_APP_STORE_ID ?
      `    <meta name="apple-itunes-app" content="app-id=${escapeHtml(APPLE_APP_STORE_ID)}">\n`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Join Sound Room Jam</title>
${smartBannerMeta}    <style>
      body { margin: 0; color: #111; background: #fafafa; }
    </style>
</head>
<body>
    <div style="text-align: center; font-family: system-ui, sans-serif; padding-top: 50px; max-width: 28rem; margin: 0 auto;">
        <h2>Redirecting to Sound Room…</h2>
        <p>Session hosted by <strong>${hostLabel}</strong>.</p>
        <p>If you don't have the app installed, you'll be redirected to the store.</p>
    </div>
    <script>
        (function () {
            var roomId = ${roomIdJs};
            var appStoreUrl = ${JSON.stringify(appStoreUrl)};
            var playStoreUrl = ${JSON.stringify(playStoreUrl)};
            var deepLink = 'soundroom://jam?id=' + encodeURIComponent(roomId);
            var left = false;
            function markLeft() { left = true; }
            window.addEventListener('pagehide', markLeft);
            window.addEventListener('blur', markLeft);
            document.addEventListener('visibilitychange', function () {
                if (document.visibilityState === 'hidden') markLeft();
            });
            window.location.href = deepLink;
            setTimeout(function () {
                if (left) return;
                var ua = navigator.userAgent || '';
                var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
                var isAndroid = /android/i.test(ua);
                if (isIOS) {
                    window.location.href = appStoreUrl;
                } else if (isAndroid) {
                    window.location.href = playStoreUrl;
                } else {
                    document.body.innerHTML = '<div style="text-align:center;font-family:system-ui,sans-serif;padding-top:50px;"><h2>Please open this link on your mobile device</h2><p>Sound Room is available on iOS and Android.</p></div>';
                }
            }, 2500);
        })();
    </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(html);
});

/** Pre-connect JSON for native clients: host + permissions by room id (same process memory as Socket.IO). */
app.get('/api/room/:id', (req, res) => {
  const param = req.params.id;
  const idStr = typeof param === 'string' ? param : Array.isArray(param) ? param[0] ?? '' : '';
  const rid = normalizeRoomId(idStr);
  if (!rid) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(400).json({ success: false, message: 'Invalid room code' });
    return;
  }
  const room = rooms.get(rid);
  if (!room) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(404).json({ success: false, message: 'Room not found' });
    return;
  }
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    success: true,
    roomId: rid,
    hostUsername: room.hostUsername,
    permissions: {
      sharedControl: Boolean(room.permissions.sharedControl),
    },
  });
});

io.on('connection', (socket: Socket) => {
  console.log('User connected:', socket.id);

  socket.on('get_active_rooms', (callback) => {
    const activeRooms = Array.from(rooms.values()).map(r => ({
      id: r.id,
      hostName: r.users.find(u => u.isHost)?.username || 'Unknown',
      usersCount: r.users.length
    }));
    if (callback) callback({ success: true, rooms: activeRooms });
  });

  socket.on('create_room', (data: { username: string, sharedControl: boolean, subsonicInfo?: any, customRoomId?: string }, callback) => {
    let roomId: string;
    if (data.customRoomId?.trim()) {
      roomId = data.customRoomId.trim().toUpperCase();
      if (rooms.has(roomId)) {
        return callback({ success: false, message: 'Room code already exists. Please choose a different one.' });
      }
    } else {
      do {
        roomId = generateRandomRoomId();
      } while (rooms.has(roomId));
    }
    
    const newRoom: Room = {
      id: roomId,
      hostId: socket.id,
      hostUsername: data.username,
      users: [{ id: socket.id, username: data.username, isHost: true, isReady: true }],
      playbackState: {
        isPlaying: false,
        currentTime: 0,
        songId: null,
        queue: [],
        queueIndex: 0,
        updatedAt: Date.now(),
        repeatMode: 'off'
      },
      permissions: {
        // Coerce wire payloads (some clients send strings / 0/1).
        sharedControl:
          data.sharedControl === true ||
          (data as { sharedControl?: unknown }).sharedControl === 'true' ||
          (data as { sharedControl?: unknown }).sharedControl === 1,
      },
      subsonicInfo: data.subsonicInfo
    };
    
    rooms.set(roomId, newRoom);
    socket.join(roomId);
    
    console.log(`Room ${roomId} created by ${data.username}`);
    callback({ success: true, roomId });
  });

  socket.on('join_room', (data: { roomId: string, username: string, listenMode?: 'together' | 'remote' }, callback) => {
    const rid = normalizeRoomId(data.roomId);
    if (!rid) {
      return callback({ success: false, message: 'Invalid room code' });
    }
    const room = rooms.get(rid);
    if (!room) {
      return callback({ success: false, message: 'Room not found' });
    }
    
    // Clear deletion timeout if it exists
    if (roomTimeouts.has(rid)) {
      clearTimeout(roomTimeouts.get(rid));
      roomTimeouts.delete(rid);
    }
    
    // Reclaim host if matching username
    const isHost = (data.username === room.hostUsername);
    if (isHost) {
      room.hostId = socket.id;
    }
    
    // Remove old disconnected entry if they somehow exist (shouldn't happen)
    room.users = room.users.filter(u => u.username !== data.username);

    const listenMode: 'together' | 'remote' | undefined =
      isHost ? undefined : (data.listenMode === 'remote' ? 'remote' : 'together');
    const newUser: User = {
      id: socket.id,
      username: data.username,
      isHost,
      isReady: true,
      ...(listenMode ? { listenMode } : {}),
    };
    room.users.push(newUser);
    socket.join(rid);
    
    // Notify existing users about the new user
    socket.to(rid).emit('user_joined', newUser);

    // Send full room update to ALL users (including new user) to ensure sync
    io.to(rid).emit('room_update', room);
    
    console.log(`${data.username} joined room ${rid}`);
    callback({ success: true, room });
  });

  /** Pre-join: host + session type for join UI (authoritative; do not trust URL query params). */
  socket.on('peek_room', (roomId: string, callback: (res: {
    success: boolean;
    message?: string;
    hostUsername?: string;
    permissions?: { sharedControl: boolean };
  }) => void) => {
    const rid = normalizeRoomId(roomId);
    if (!rid) {
      callback({ success: false, message: 'Invalid room code' });
      return;
    }
    const room = rooms.get(rid);
    if (!room) {
      callback({ success: false, message: 'Room not found' });
      return;
    }
    callback({
      success: true,
      hostUsername: room.hostUsername,
      permissions: {
        sharedControl: Boolean(room.permissions.sharedControl),
      },
    });
  });

  socket.on('update_playback_state', (data: { roomId: string, state: any }) => {
    const rid = normalizeRoomId(data.roomId);
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room) return;
    const isHost = room.hostId === socket.id;
    const member = room.users.find((u) => u.id === socket.id);
    if (!member) return;
    // Host always; guests only when "group controls" (remote join is control-from-phone, same rule).
    const canControl = isHost || room.permissions.sharedControl;
    if (!canControl) return;
    room.playbackState = { ...room.playbackState, ...data.state, updatedAt: Date.now() };
    // Everyone in the room (including sender) gets the same snapshot so all clients stay aligned.
    io.to(rid).emit('playback_state_updated', room.playbackState);
  });

  socket.on('request_sync', (data: { roomId: string }) => {
    const rid = normalizeRoomId(data.roomId);
    if (!rid) return;
    const room = rooms.get(rid);
    if (room && room.hostId === socket.id) {
      socket.to(rid).emit('playback_state_updated', room.playbackState);
    }
  });

  /** Any member can ask the server for the latest stored playback snapshot (e.g. guest right after join). */
  socket.on('request_playback_sync', (data: { roomId: string }) => {
    const rid = normalizeRoomId(data?.roomId);
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room) return;
    socket.emit('playback_state_updated', room.playbackState);
  });

  /** Refresh full room (participants, etc.) from server — e.g. when opening the jam dialog. */
  socket.on('request_room_snapshot', (roomId: string) => {
    const rid = normalizeRoomId(roomId);
    if (!rid) return;
    const room = rooms.get(rid);
    if (room) socket.emit('room_update', room);
  });

  socket.on('destroy_room', (roomId: string, callback) => {
    const rid = normalizeRoomId(roomId);
    if (!rid) {
      if (callback) callback({ success: false, message: 'Invalid room' });
      return;
    }
    const room = rooms.get(rid);
    if (room && room.hostId === socket.id) {
      io.to(rid).emit('room_destroyed');
      rooms.delete(rid);
      console.log(`Room ${rid} destroyed by host.`);
      if (callback) callback({ success: true });
    } else {
      if (callback) callback({ success: false, message: 'Not authorized or room not found' });
    }
  });

  socket.on('rename_room', (data: { oldId: string, newId: string }, callback: any) => {
    if (!data.newId || data.newId.trim() === '') return callback({ success: false, message: 'Invalid room code' });
    const safeNewId = data.newId.trim().toUpperCase();
    
    if (rooms.has(safeNewId)) {
        return callback({ success: false, message: 'Room code already exists' });
    }
    
    const oldRid = normalizeRoomId(data.oldId);
    if (!oldRid) return callback({ success: false, message: 'Invalid room code' });
    const room = rooms.get(oldRid);
    if (!room) return callback({ success: false, message: 'Room not found' });
    if (room.hostId !== socket.id) return callback({ success: false, message: 'Not authorized' });

    room.id = safeNewId;
    rooms.delete(oldRid);
    rooms.set(safeNewId, room);

    // Re-assign socket.io rooms
    const clients = io.sockets.adapter.rooms.get(oldRid);
    if (clients) {
      for (const clientId of clients) {
        const clientSocket = io.sockets.sockets.get(clientId);
        if (clientSocket) {
          clientSocket.leave(oldRid);
          clientSocket.join(safeNewId);
        }
      }
    }
    
    io.to(safeNewId).emit('room_renamed', safeNewId);
    console.log(`Room ${oldRid} renamed to ${safeNewId}`);
    callback({ success: true, newId: safeNewId });
  });

  socket.on('leave_room', (roomId: string) => {
    const rid = normalizeRoomId(roomId);
    if (!rid) return;
    const room = rooms.get(rid);
    if (room) {
      room.users = room.users.filter(u => u.id !== socket.id);
      // Emit while socket is still in the room so `to(rid)` reliably reaches everyone else.
      socket.to(rid).emit('room_update', room);
      socket.to(rid).emit('user_left', { id: socket.id });

      // If empty, schedule deletion
      if (room.users.length === 0) {
        if (!roomTimeouts.has(rid)) {
          const timeout = setTimeout(() => {
            rooms.delete(rid);
            roomTimeouts.delete(rid);
            console.log(`Room ${rid} deleted because it remained empty.`);
          }, 600000); // 10 minutes grace period
          roomTimeouts.set(rid, timeout);
        }
      } else if (room.hostId === socket.id) {
        // If host leaves intentionally by hitting Leave, maybe we want to destroy the room?
        // But for now we just don't reassign the host to a guest.
      }
    }
    socket.leave(rid);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // Find rooms user was in and remove them
    for (const [roomId, room] of rooms.entries()) {
      if (room.users.find(u => u.id === socket.id)) {
        room.users = room.users.filter(u => u.id !== socket.id);
        // Disconnected socket cannot broadcast — use io.to. Same room key as in rooms Map.
        io.to(roomId).emit('room_update', room);
        io.to(roomId).emit('user_left', { id: socket.id });
        if (room.users.length === 0) {
          if (!roomTimeouts.has(roomId)) {
            const timeout = setTimeout(() => {
              rooms.delete(roomId);
              roomTimeouts.delete(roomId);
              console.log(`Room ${roomId} deleted because it remained empty.`);
            }, 600000); // 10 minutes grace period
            roomTimeouts.set(roomId, timeout);
          }
        } else if (room.hostId === socket.id) {
          // Do not promote guest to host
        }
      }
    }
  });
});

// Optional SPA: set JAM_UI_DIST to a built web app directory (e.g. Navidrome UI build).
// When unset, this process is coordination-only (Socket.IO); use a separate host for the UI if needed.
const uiDist = process.env.JAM_UI_DIST;
if (uiDist) {
  const clientDistPath = path.resolve(uiDist);
  app.use(express.static(clientDistPath));
  app.use((req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.json({ service: 'jam', socketIO: true });
  });
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
