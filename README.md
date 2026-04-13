# jam-server

**This folder** (`jam-server/`, the copy next to `package.json` and `index.ts`) is the **standalone** Jam server. Setup, env vars, deployment, and how to keep working on it are documented **here** in `README.md`—not under `navidrome-jam/server/`.

---

Standalone **Jam** coordination service: [Socket.IO](https://socket.io/) rooms, playback metadata sync, and optional hosting of a built web UI. It does **not** stream audio or replace your music server (e.g. Navidrome); clients still use Subsonic/REST for library and streams.

Use this directory when you want to **build, run, and deploy the jam process separately** from the Navidrome UI fork in `navidrome-jam`.

---

## Quick start

```bash
npm install
npm start
```

- Default HTTP port: **3001** (override with `PORT`).
- With no UI path configured, `GET /` returns JSON: `{"service":"jam","socketIO":true}`.
- Socket.IO uses the default path `**/socket.io`** (same as the Socket.IO client default).

Optional: create a `.env` file in this directory (loaded automatically via `dotenv`):

```env
PORT=3001
# JAM_UI_DIST=/absolute/path/to/spa/build
```

---

## Environment variables


| Variable      | Required | Description                                                                                                                                                                                          |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`        | No       | HTTP listen port. Default `3001`.                                                                                                                                                                    |
| `JAM_UI_DIST` | No       | Absolute path to a **built** SPA directory (e.g. Navidrome UI `build/`). If set, static files and SPA fallback `index.html` are served; if unset, only the small JSON root and Socket.IO are active. |


---

## Serving the web UI from the same host

1. Build your web app (e.g. in `navidrome-jam`, build `navidrome_src/ui`).
2. Point `JAM_UI_DIST` at that `build` folder.
3. Put **Nginx** (or similar) in front on **443**, proxy WebSocket upgrades to this Node process, and proxy Navidrome `/rest` (and related) to your music server if you use a single hostname. See `navidrome-jam/nginx_jam.conf` for an example combined layout.

Clients should connect Socket.IO to the **same public origin** people use in the browser for the jam site (HTTPS → WSS), not necessarily the Navidrome URL.

---

## Continuing development

### Everyday commands


| Command            | Purpose                           |
| ------------------ | --------------------------------- |
| `npm start`        | Run the server with `ts-node`.    |
| `npx tsc --noEmit` | Typecheck without emitting files. |


Suggested additions you can add to `package.json` when you want them:

- `"typecheck": "tsc --noEmit"`
- `"dev": "nodemon --exec ts-node index.ts"` for auto-restart on save (nodemon is already a devDependency).

### Where the logic lives

- `**index.ts`** — Express app, Socket.IO `Server`, in-memory `rooms` map, and all event handlers (`create_room`, `join_room`, `update_playback_state`, etc.).

### Keeping in sync with `navidrome-jam`

If the canonical server code still lives under `navidrome-jam/server/`, copy changes **from** that tree **into** this repo when you merge features (or vice versa if this becomes the source of truth). Compare `index.ts` and `package.json` after each sync.

### Protocol and client documentation

For operators and client authors (events, deployment, mobile URL rules), see the full write-up in the monorepo:

`navidrome-jam/docs/TECHNICAL.md`

Copy or open that file next to this project when you extend the wire protocol.

### Socket.IO events (overview)

The server implements handlers including (non-exhaustive): `get_active_rooms`, `create_room`, `join_room`, `peek_room`, `update_playback_state`, `request_sync`, `request_playback_sync`, `request_room_snapshot`, `destroy_room`, `rename_room`, `leave_room`. Emits include `room_update`, `playback_state_updated`, `user_joined`, `user_left`, `room_destroyed`, `room_renamed`.

When changing behavior, update both server and all clients (web `JamContext`, future native apps) so room IDs, permissions, and playback snapshots stay compatible.

### Production checklist

- Run behind a reverse proxy with **TLS** and WebSocket **Upgrade** headers (see example Nginx config in `navidrome-jam`).
- Restrict CORS in `index.ts` if you currently rely on `origin: '*'` for development.
- Rooms are **in-memory only**; restarting the process clears all rooms. Plan persistence or multi-instance only if you add them explicitly.

---

## License

`ISC` (see `package.json`). Align with the parent project if you redistribute.