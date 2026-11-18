/**
 * Jam coordination server (Socket.IO). Standalone copy: live docs are in this directory — see README.md next to this file.
 */
import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { Server, Socket } from 'socket.io';
import cors from 'cors';

/** When `CORS_ORIGIN` is unset or `*`, all origins are allowed. Otherwise comma-separated HTTPS origins (e.g. `https://jam.valaki.in,https://jam.soundroom.in`). Requests with no `Origin` (many native apps) are allowed when a list is set. */
function isOriginAllowed(origin: string | undefined): boolean {
  const raw = process.env.CORS_ORIGIN?.trim();
  if (!raw || raw === '*') return true;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (origin === undefined || origin === '') return true;
  return list.includes(origin);
}

const app = express();

/** Numeric Apple App Store ID — Smart App Banner, /join fallback URL, and optional AASA docs. Defaults to Sound Room (6762375751); override with `APPLE_APP_STORE_ID`. */
const APPLE_APP_STORE_ID =
  process.env.APPLE_APP_STORE_ID?.trim() || '6762375751';
/** Apple Developer Team ID — required for Universal Links AASA `appID` (`{teamId}.{bundleId}`). */
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID?.trim() ?? '';
/** iOS bundle identifier (defaults to Sound Room). */
const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID?.trim() || 'com.valaki.soundroom';

app.use(
  cors({
    origin: (origin, callback) => callback(null, isOriginAllowed(origin)),
  })
);

/** Apple Universal Links — serve AASA on each public jam host (currently `jam.valaki.in` + parallel `jam.soundroom.in`). No redirects. Set APPLE_TEAM_ID (+ optional APPLE_BUNDLE_ID). */
app.get('/.well-known/apple-app-site-association', (_req, res) => {
  if (!APPLE_TEAM_ID) {
    res.status(404).type('text/plain').send('Apple Team ID not configured (set APPLE_TEAM_ID).');
    return;
  }
  const body = {
    applinks: {
      details: [
        {
          appIDs: [`${APPLE_TEAM_ID}.${APPLE_BUNDLE_ID}`],
          components: [
            {
              '/': '/join*',
              comment: 'Jam session invite links',
            },
          ],
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

/** Shared styles for `/join` and error responses — colorful music-forward landing. */
const JOIN_LANDING_CSS = `
  :root {
    --jam-violet: #5b21b6;
    --jam-fuchsia: #c026d3;
    --jam-rose: #f43f5e;
    --jam-amber: #fbbf24;
    --jam-cyan: #22d3ee;
    --jam-card: rgba(15, 6, 32, 0.55);
    --jam-card-border: rgba(255, 255, 255, 0.14);
    --jam-text: #faf5ff;
    --jam-muted: rgba(250, 245, 255, 0.78);
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body.jam-join-body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: var(--jam-text);
    background: #0f0518;
    -webkit-font-smoothing: antialiased;
  }
  .jam-bg {
    position: fixed;
    inset: 0;
    z-index: 0;
    background:
      radial-gradient(ellipse 120% 80% at 20% 0%, rgba(192, 38, 211, 0.45), transparent 55%),
      radial-gradient(ellipse 100% 70% at 100% 30%, rgba(34, 211, 238, 0.25), transparent 50%),
      radial-gradient(ellipse 80% 60% at 50% 100%, rgba(244, 63, 94, 0.35), transparent 45%),
      linear-gradient(160deg, #1e0b3d 0%, #0f0518 40%, #1a0a2e 100%);
    animation: jam-bg-drift 14s ease-in-out infinite alternate;
  }
  @keyframes jam-bg-drift {
    0% { filter: hue-rotate(0deg) saturate(1); transform: scale(1); }
    100% { filter: hue-rotate(18deg) saturate(1.15); transform: scale(1.03); }
  }
  .jam-noise {
    position: fixed;
    inset: 0;
    z-index: 1;
    opacity: 0.04;
    pointer-events: none;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  }
  .jam-join-page {
    position: relative;
    z-index: 2;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 1.5rem 1.25rem 2.5rem;
  }
  .jam-join-wrap {
    width: 100%;
    max-width: 22rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.75rem;
  }
  .jam-visualizer {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    gap: 5px;
    height: 3.25rem;
  }
  .jam-bar {
    width: 6px;
    border-radius: 99px;
    background: linear-gradient(180deg, var(--jam-cyan), var(--jam-fuchsia) 50%, var(--jam-rose));
    opacity: 0.9;
    transform-origin: bottom center;
    animation: jam-bar-bounce 0.9s ease-in-out infinite;
  }
  .jam-bar:nth-child(1) { height: 40%; animation-delay: 0s; }
  .jam-bar:nth-child(2) { height: 75%; animation-delay: 0.1s; }
  .jam-bar:nth-child(3) { height: 100%; animation-delay: 0.05s; }
  .jam-bar:nth-child(4) { height: 55%; animation-delay: 0.2s; }
  .jam-bar:nth-child(5) { height: 85%; animation-delay: 0.15s; }
  .jam-bar:nth-child(6) { height: 50%; animation-delay: 0.25s; }
  .jam-bar:nth-child(7) { height: 70%; animation-delay: 0.08s; }
  @keyframes jam-bar-bounce {
    0%, 100% { transform: scaleY(0.35); }
    50% { transform: scaleY(1); }
  }
  .jam-card {
    width: 100%;
    text-align: center;
    padding: 1.75rem 1.5rem 1.85rem;
    border-radius: 1.35rem;
    background: var(--jam-card);
    border: 1px solid var(--jam-card-border);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.06) inset,
      0 24px 48px rgba(0, 0, 0, 0.35),
      0 0 80px rgba(192, 38, 211, 0.12);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
  }
  .jam-eyebrow {
    margin: 0 0 0.35rem;
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    background: linear-gradient(90deg, var(--jam-cyan), var(--jam-amber), var(--jam-fuchsia));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .jam-title {
    margin: 0 0 0.65rem;
    font-size: 1.45rem;
    font-weight: 700;
    line-height: 1.2;
    letter-spacing: -0.02em;
    text-shadow: 0 0 40px rgba(192, 38, 211, 0.35);
  }
  .jam-lede {
    margin: 0;
    font-size: 0.95rem;
    line-height: 1.55;
    color: var(--jam-muted);
  }
  .jam-host {
    display: inline-block;
    margin-top: 0.5rem;
    padding: 0.2rem 0.65rem;
    border-radius: 999px;
    font-weight: 600;
    color: #fff;
    background: linear-gradient(135deg, rgba(192, 38, 211, 0.35), rgba(34, 211, 238, 0.2));
    border: 1px solid rgba(255, 255, 255, 0.12);
  }
  .jam-note {
    font-size: 1.35rem;
    line-height: 1;
    opacity: 0.35;
    user-select: none;
  }
  .jam-join-page--error .jam-title { color: #fecdd3; }
  @media (prefers-reduced-motion: reduce) {
    .jam-bg { animation: none; }
    .jam-bar { animation: none; transform: scaleY(0.65); }
  }
`;

function joinErrorHtml(title: string, detail: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — Sound Room</title>
  <style>${JOIN_LANDING_CSS}</style>
</head>
<body class="jam-join-body">
  <div class="jam-bg" aria-hidden="true"></div>
  <div class="jam-noise" aria-hidden="true"></div>
  <div class="jam-join-page jam-join-page--error">
    <div class="jam-join-wrap">
      <div class="jam-visualizer" aria-hidden="true">
        <span class="jam-bar"></span><span class="jam-bar"></span><span class="jam-bar"></span>
        <span class="jam-bar"></span><span class="jam-bar"></span>
      </div>
      <div class="jam-card">
        <p class="jam-eyebrow">Sound Room</p>
        <h1 class="jam-title">${escapeHtml(title)}</h1>
        <p class="jam-lede">${escapeHtml(detail)}</p>
      </div>
    </div>
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
  // Longer ping window helps iOS background / cell handoff; overridable via env for edge proxies.
  pingInterval: Math.max(10_000, Number(process.env.JAM_SOCKET_PING_MS) || 25_000),
  pingTimeout: Math.max(20_000, Number(process.env.JAM_SOCKET_PING_TIMEOUT_MS) || 90_000),
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
    shuffleEnabled?: boolean;
    shuffleOrder?: number[];
    shufflePosition?: number;
    /** Monotonic per server merge — clients prefer this over `updatedAt` when both present. */
    playbackSeq?: number;
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
  /** Last time the host changed `queueIndex` or `songId` (for guest race / tie-break). */
  lastHostTrackChangeAt?: number;
}

const rooms = new Map<string, Room>();
const roomTimeouts = new Map<string, NodeJS.Timeout>();

/**
 * Coalesces `playback_state_updated` per room so tight client↔server feedback (apply → emit → apply)
 * does not flood every member. Merges stay immediate; only the Socket.IO fan-out is throttled.
 * Override with `JAM_PLAYBACK_BROADCAST_MIN_MS` (default 120).
 */
const JAM_PLAYBACK_BROADCAST_MIN_MS = Math.max(
  40,
  Math.min(2000, Number(process.env.JAM_PLAYBACK_BROADCAST_MIN_MS ?? '120') || 120)
);
const jamPlaybackBroadcastState = new Map<
  string,
  { lastEmitMs: number; trailingTimer?: NodeJS.Timeout }
>();

function clearJamPlaybackBroadcastState(roomId: string) {
  const s = jamPlaybackBroadcastState.get(roomId);
  if (s?.trailingTimer) clearTimeout(s.trailingTimer);
  jamPlaybackBroadcastState.delete(roomId);
}

function emitPlaybackStateThrottled(io: Server, roomId: string) {
  const room = rooms.get(roomId);
  if (!room) {
    clearJamPlaybackBroadcastState(roomId);
    return;
  }
  const now = Date.now();
  let entry = jamPlaybackBroadcastState.get(roomId);
  if (!entry) {
    entry = { lastEmitMs: 0 };
    jamPlaybackBroadcastState.set(roomId, entry);
  }

  const flush = () => {
    entry!.trailingTimer = undefined;
    const r = rooms.get(roomId);
    if (!r) {
      jamPlaybackBroadcastState.delete(roomId);
      return;
    }
    entry!.lastEmitMs = Date.now();
    io.to(roomId).emit('playback_state_updated', r.playbackState);
  };

  const elapsed = now - entry.lastEmitMs;
  if (elapsed >= JAM_PLAYBACK_BROADCAST_MIN_MS) {
    if (entry.trailingTimer) {
      clearTimeout(entry.trailingTimer);
      entry.trailingTimer = undefined;
    }
    flush();
    return;
  }

  if (!entry.trailingTimer) {
    entry.trailingTimer = setTimeout(flush, JAM_PLAYBACK_BROADCAST_MIN_MS - elapsed);
  }
}

/**
 * Merges `incoming` into `prev` without letting missing keys wipe fields.
 * Prevents `{ ...prev, ...incoming }` from replacing the whole queue with `null`
 * or reverting the host's track when a guest sends a sparse or stale payload.
 */
function mergePlaybackSelective(
  prev: Room['playbackState'],
  incoming: Record<string, unknown>
): Room['playbackState'] {
  const out: Room['playbackState'] = { ...prev };
  if (typeof incoming.isPlaying === 'boolean') out.isPlaying = incoming.isPlaying;
  if (
    typeof incoming.currentTime === 'number' &&
    Number.isFinite(incoming.currentTime)
  ) {
    out.currentTime = incoming.currentTime;
  }
  if (typeof incoming.repeatMode === 'string') out.repeatMode = incoming.repeatMode;
  if (Array.isArray(incoming.queue)) out.queue = incoming.queue as Room['playbackState']['queue'];
  if (
    typeof incoming.queueIndex === 'number' &&
    Number.isInteger(incoming.queueIndex) &&
    incoming.queueIndex >= 0
  ) {
    out.queueIndex = incoming.queueIndex;
  }
  if (typeof incoming.songId === 'string') {
    out.songId = incoming.songId;
  }
  if (typeof incoming.shuffleEnabled === 'boolean') {
    out.shuffleEnabled = incoming.shuffleEnabled;
  }
  if (
    Array.isArray(incoming.shuffleOrder) &&
    (incoming.shuffleOrder as unknown[]).every(
      (x) => typeof x === 'number' && Number.isInteger(x) && x >= 0
    )
  ) {
    out.shuffleOrder = incoming.shuffleOrder as number[];
  }
  if (
    typeof incoming.shufflePosition === 'number' &&
    Number.isInteger(incoming.shufflePosition) &&
    incoming.shufflePosition >= 0
  ) {
    out.shufflePosition = incoming.shufflePosition;
  }
  return out;
}

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

  const desktopFallbackInner = `<div class="jam-join-wrap"><div class="jam-visualizer" aria-hidden="true"><span class="jam-bar"></span><span class="jam-bar"></span><span class="jam-bar"></span><span class="jam-bar"></span><span class="jam-bar"></span><span class="jam-bar"></span><span class="jam-bar"></span></div><div class="jam-card"><p class="jam-eyebrow">Sound Room</p><h1 class="jam-title">Open this link on your phone</h1><p class="jam-lede">Listening parties run in the Sound Room app on <strong>iOS</strong> and <strong>Android</strong>. Copy the link or open it on your mobile device.</p><p class="jam-note" aria-hidden="true" style="margin-top:1rem">♫ ♪ ♫</p></div></div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Join jam — Sound Room</title>
${smartBannerMeta}    <style>${JOIN_LANDING_CSS}</style>
</head>
<body class="jam-join-body">
    <div class="jam-bg" aria-hidden="true"></div>
    <div class="jam-noise" aria-hidden="true"></div>
    <div class="jam-join-page" id="jam-join-root">
        <div class="jam-join-wrap">
            <div class="jam-visualizer" aria-hidden="true">
                <span class="jam-bar"></span><span class="jam-bar"></span><span class="jam-bar"></span>
                <span class="jam-bar"></span><span class="jam-bar"></span><span class="jam-bar"></span><span class="jam-bar"></span>
            </div>
            <div class="jam-card">
                <p class="jam-eyebrow">You're invited</p>
                <h1 class="jam-title">Step into the jam</h1>
                <p class="jam-lede">Opening Sound Room…</p>
                <p class="jam-lede" style="margin-top:1rem">Hosted by <span class="jam-host">${hostLabel}</span></p>
                <p class="jam-lede" style="margin-top:0.85rem;font-size:0.85rem">No app yet? We'll send you to the store in a moment.</p>
                <p class="jam-note" aria-hidden="true" style="margin-top:1rem">♪ ♫ ♪</p>
            </div>
        </div>
    </div>
    <script>
        (function () {
            var roomId = ${roomIdJs};
            var appStoreUrl = ${JSON.stringify(appStoreUrl)};
            var playStoreUrl = ${JSON.stringify(playStoreUrl)};
            var desktopFallbackInner = ${JSON.stringify(desktopFallbackInner)};
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
                    var root = document.getElementById('jam-join-root');
                    if (root) root.innerHTML = desktopFallbackInner;
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
        repeatMode: 'off',
        shuffleEnabled: false,
        shuffleOrder: [],
        shufflePosition: 0,
        playbackSeq: 0,
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
    // While the host socket is disconnected, `users` has no `isHost` row. Reject merges so a shared-control
    // guest cannot push `isPlaying: false` (or queue drift) into room truth during the host reconnect gap.
    if (!room.users.some((u) => u.isHost)) {
      return;
    }
    const isHost = room.hostId === socket.id;
    const member = room.users.find((u) => u.id === socket.id);
    if (!member) return;
    // Host always; guests only when "group controls" (remote join is control-from-phone, same rule).
    const canControl = isHost || room.permissions.sharedControl;
    if (!canControl) return;

    const incoming = (data.state || {}) as Record<string, unknown>;
    const prev = room.playbackState;

    // Shared control: right after the host changes track, still merge transport from guests but drop
    // queue / index / songId so a stale full payload cannot overwrite the new host state (was causing
    // permanent desync: joiner stayed on old track while server truth regressed).
    let incomingForMerge: Record<string, unknown> = incoming;
    if (!isHost && room.permissions.sharedControl) {
      const idxIn = incoming.queueIndex;
      const sidIn = incoming.songId;
      const guestMovesTrack =
        (idxIn !== undefined && idxIn !== prev.queueIndex) ||
        (sidIn !== undefined && sidIn !== prev.songId);
      const hostChangedAt = room.lastHostTrackChangeAt ?? 0;
      if (guestMovesTrack && Date.now() - hostChangedAt < 2000) {
        incomingForMerge = {};
        if (typeof incoming.isPlaying === 'boolean')
          incomingForMerge.isPlaying = incoming.isPlaying;
        if (
          typeof incoming.currentTime === 'number' &&
          Number.isFinite(incoming.currentTime)
        ) {
          incomingForMerge.currentTime = incoming.currentTime;
        }
        if (typeof incoming.repeatMode === 'string')
          incomingForMerge.repeatMode = incoming.repeatMode;
      }
    }

    const nextSeq = (prev.playbackSeq ?? 0) + 1;
    const mergedBody = mergePlaybackSelective(prev, incomingForMerge);
    room.playbackState = {
      ...mergedBody,
      updatedAt: Date.now(),
      playbackSeq: nextSeq,
    };
    const merged = room.playbackState;

    if (isHost) {
      const idxChanged = merged.queueIndex !== prev.queueIndex;
      const sidChanged = merged.songId !== prev.songId;
      if (idxChanged || sidChanged) {
        room.lastHostTrackChangeAt = Date.now();
      }
    }

    // Fan-out is throttled per room to damp feedback loops (multiple clients echoing transport).
    emitPlaybackStateThrottled(io, rid);
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
      clearJamPlaybackBroadcastState(rid);
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
    clearJamPlaybackBroadcastState(oldRid);
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
      const wasHostSocket = room.hostId === socket.id;
      room.users = room.users.filter(u => u.id !== socket.id);
      if (wasHostSocket) {
        room.hostId = '';
      }
      // Emit while socket is still in the room so `to(rid)` reliably reaches everyone else.
      socket.to(rid).emit('room_update', room);
      socket.to(rid).emit('user_left', { id: socket.id });

      // If empty, schedule deletion
      if (room.users.length === 0) {
        if (!roomTimeouts.has(rid)) {
          const timeout = setTimeout(() => {
            clearJamPlaybackBroadcastState(rid);
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
        const wasHostSocket = room.hostId === socket.id;
        room.users = room.users.filter(u => u.id !== socket.id);
        if (wasHostSocket) {
          room.hostId = '';
        }
        // Disconnected socket cannot broadcast — use io.to. Same room key as in rooms Map.
        io.to(roomId).emit('room_update', room);
        io.to(roomId).emit('user_left', { id: socket.id });
        if (room.users.length === 0) {
          if (!roomTimeouts.has(roomId)) {
            const timeout = setTimeout(() => {
              clearJamPlaybackBroadcastState(roomId);
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
