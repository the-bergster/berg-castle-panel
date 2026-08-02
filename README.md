# Berg Castle Control Panel

Personal home-control web app for Simon Berg's home in Sherman, CT ("Berg Castle").
Talks directly to Lutron RadioRA2 processors over Telnet for lights and to Sonos
ZonePlayers over UPnP/SOAP for music, bypasses Josh.ai entirely, and streams live
state via WebSocket. Hosted on the Jony Mac, exposed publicly via Cloudflare Tunnel +
Cloudflare Access, installable as a PWA.

**Repo:** [the-bergster/berg-castle-panel](https://github.com/the-bergster/berg-castle-panel) (private)
**Built** 2026-07-30 in a single ~10-hour session between Simon and Jony (his creative-director AI). See `HISTORY.md` for the story of how this got built (Sonos → Josh API crack → Lutron reverse engineering → this app).

---

## What it does

### Music (Sonos)

- Every zone in the house, grouped exactly as Sonos sees it — 19 rooms, live topology
- Full transport: play/pause, next/previous, scrub, shuffle, repeat, crossfade
- Queue management: browse, jump to any track, drag to reorder, remove, clear,
  save the queue as a Sonos playlist
- Album art everywhere, proxied and cached through the server
- Grouping: join, leave, set exact membership, party mode, drop all groups
- Per-room and per-group volume, mute, and proportional group volume
- Sonos Favorites, Sonos Playlists, built-in SomaFM stations, line-in (the turntable)
- TV input on the soundbars, so playing music on an Arc is reversible from here.
  This matters: playing anything on a soundbar replaces its TV audio, and without a
  way back the panel could break TV sound but not fix it. Master TV was found in
  exactly that state — pointed at a leftover announcement MP3.
- Catalog search via Spotify, playing straight to any room
- Per-model EQ: bass, treble, loudness, and night mode / speech enhancement /
  sub gain / surround level where the hardware actually has them
- Sleep timers
- Real-time updates pushed by the speakers themselves (UPnP GENA), not polling

### Lights (Lutron)

- Full control of every Lutron light in the house (114 controllable outputs across 35 rooms)
- Real-time live state via WebSocket + Lutron `#MONITORING` — see any external change (Pico button press, Josh command, Lutron app) reflected instantly
- Pico-native scene execution (~50ms) for whole-house scenes like "Bedtime", "Sleep", "All Off"
- Synthetic scenes for cross-cutting groups (e.g. Fireplaces On/Off) via pipelined direct-Lutron commands
- Per-output dimmer sliders, per-room quick actions, floor/zone grouping
- PWA (add to home screen on iPhone / Android)
- Cloudflare Access authentication — only `me@simonberg.ai` can log in

Direct Lutron control means:
- Sub-100ms response for single-output changes
- Exact dim level (0.00–100.00 float)
- Fade times per command
- Read-back state (not just "on/off" like Josh)
- No subscription needed
- Works even if Josh is down / lapsed

---

## Architecture

```
Phone/Browser
    │
    │  HTTPS + Cloudflare Access auth
    ▼
Cloudflare Edge (home.bergcastle.com)
    │
    │  Cloudflare Tunnel (outbound QUIC)
    ▼
Jony Mac at 192.168.2.100
    │
    │  cloudflared → localhost:4321
    ▼
Node.js server (server.js)
    ├─ /api/rooms, /api/state, /api/set, /api/room-set,
    │  /api/zone-set, /api/all-off, /api/scenes, /api/scene,
    │  /api/synthetic-scene
    └─ WebSocket / — live state broadcast
    │
    │  Persistent telnet connection
    │  josh / 1234 credentials
    │  #MONITORING,255,1 enabled at boot
    ▼
Lutron RadioRA2 processor at 192.168.2.158:23
    │
    ▼
Every Lutron dimmer / switch / keypad in the house
```

### Music path

```
Node.js server (sonos/)
    ├─ /api/sonos/*  — state, transport, volume, group, queue,
    │                  favorites, playlists, radio, line-in, search, eq, art
    ├─ NOTIFY /sonos/notify — inbound UPnP GENA events from the players
    └─ WebSocket / — sonos:* messages pushed to browsers
    │
    │  UPnP/SOAP on port 1400, no auth, no cloud
    ▼
19 Sonos zones on VLAN 2 (192.168.4.x)
    │
    ├─ topology from GetZoneGroupState (one speaker answers for the household)
    ├─ transport + queue  -> group coordinator
    └─ volume + EQ        -> the individual player
```

**Command routing is the thing to get right.** A room that is grouped does not own its
own playback — its coordinator does. Transport and queue commands sent to a grouped
member fail with UPnP 1023 or silently split the group. Volume is the opposite: it is
per-player and must never go to the coordinator. `sonos/player.js` is where that
decision is made, and every other module stays out of it.

### Why catalog search needs Spotify credentials

Sonos S2 players cannot search. Verified against this household's firmware (96.0-78270):

| Probe | Result |
|---|---|
| `ContentDirectory GetSearchCapabilities` | empty — no searchable fields advertised |
| UPnP `Search` action | UPnP 401, not implemented |
| Browse a third-party service container | UPnP 701 for every ID encoding tried |
| `MusicServices GetSessionId` (Spotify, Apple Music) | UPnP 806 — OAuth services emit no session |
| `/status/accounts` (how SoCo read tokens on S1) | empty on S2 |
| Local library `A:ALBUM` / `A:TRACKS` | 0 — no NAS share indexed |

On S2, catalog browse and search live in Sonos's cloud. The player is a playback
endpoint: hand it a URI and it plays, but it will not tell you what exists. So the
panel does what Sonos's cloud does — searches the service's own API and synthesises
the URI plus DIDL metadata the player expects.

The URI and metadata formats were derived from this household's own favorites and
queue rather than from folklore:

```
track     x-sonos-spotify:spotify%3atrack%3a<ID>?sid=12&flags=8232&sn=7
album     x-rincon-cpcontainer:1004204cspotify%3aalbum%3a<ID>?sid=12&flags=8268&sn=7
playlist  x-rincon-cpcontainer:1006206cspotify%3aplaylist%3a<ID>?sid=12&flags=8300&sn=7
desc      SA_RINCON<sid*256 + 7>_X_#Svc<sid*256 + 7>-0-Token
```

The metadata item id is `1003`/`1004`/`1006` (track/album/playlist) followed by the
flags value in hex. The `sid` and `sn` are read off the household's own content at
startup, so re-linking a Spotify account cannot silently break playback.

Without credentials everything else still works; only the Search screen goes dark.

---

## Files

### Music

- `sonos/index.js` — subsystem facade: config, wiring, capability probing, art URL validation
- `sonos/soap.js` — UPnP/SOAP transport: service catalogue, faults, timeouts, per-device queueing
- `sonos/xml.js` — small tolerant XML parser (DIDL nests; regex extraction gets it wrong)
- `sonos/topology.js` — live zone/group model from `GetZoneGroupState`
- `sonos/device.js` — typed wrappers for every SOAP action used
- `sonos/player.js` — topology-aware operations on rooms; command routing lives here
- `sonos/didl.js` — DIDL parsing, URI classification, metadata construction
- `sonos/library.js` — favorites, playlists, radio favorites, line-in, alarms
- `sonos/search.js` — pluggable catalog search; Spotify adapter
- `sonos/presets.js` — built-in SomaFM stations
- `sonos/events.js` — GENA subscriptions with an automatic polling fallback
- `sonos/api.js` — all `/api/sonos/*` routes plus the album-art proxy
- `sonos-config.json` — credentials (gitignored). Copy `sonos-config.example.json`.
- `public/music.js`, `public/music.css` — the Music app
- `discover-sonos.mjs`, `sonos-rooms.json` — legacy IP sweep, superseded by `topology.js`.
  Kept only as a bootstrap hint for seed IPs.

### Lights

- `server.js` — HTTP + WebSocket server, all API endpoints
- `lutron.js` — Persistent Telnet client with auto-reconnect and event streaming
- `rooms.js` — Room loader with soft-renames, output moves (fireplaces → their real rooms), and zone assignments
- `scenes.js` — Pico scene parser + curator (which scenes are big enough for home strip, master-off detection)
- `synthetic-scenes.js` — App-defined scenes (Fireplaces On/Off) that fire pipelined direct-Lutron commands
- `rooms.json` — Generated 1:1 dump of Lutron project's rooms + outputs. Regenerate with `node build-room-map.mjs`
- `picos.json` — Generated dump of every Pico + its programmed buttons + affected loads. Regenerate with `node build-picos.mjs`
- `build-room-map.mjs` — Parses `memory/home-control/lutron-158.xml` (the DBXML export from the Lutron processor) into `rooms.json`
- `build-picos.mjs` — Same, for `picos.json`
- `public/index.html` — App shell
- `public/app.css` — All styling
- `public/app.js` — Front-end SPA: home view, room view, WebSocket, sliders, scene triggering
- `public/favicon.svg`, `public/manifest.webmanifest` — PWA metadata

---

## How to run

Dependencies: Node 22+ (only built-in modules used — no npm install needed).

```bash
node server.js
```

Serves on port 4321. Panel: http://localhost:4321.

**As a persistent service on this Mac:** the panel is meant to run 24/7 on the Jony Mac. Currently runs from a background `nohup` process. Should ideally be wrapped in a launchd plist like cloudflared is (`~/Library/LaunchAgents/com.bergcastle.panel.plist`) — TODO.

---

## Regenerating the room map from Lutron

If the Lutron programming changes (new lights, renamed loads, added Picos), re-dump the DBXML from the processor and rebuild:

```bash
# On the Jony Mac:
python3 -c "
import socket, time
s = socket.socket(); s.settimeout(6)
s.connect(('192.168.2.158', 23))
def r(ms):
    s.settimeout(ms/1000); buf=b''; end=time.time()+ms/1000
    while time.time()<end:
        try:
            c=s.recv(65536)
            if not c: break
            buf+=c
        except: break
    return buf
r(1500); s.sendall(b'lutron\r\n'); r(1500); s.sendall(b'lutron\r\n'); r(1500)
s.sendall(b'?SYSTEM,12\r\n')
buf = b''
end = time.time() + 60; last = time.time()
while time.time() < end:
    try:
        c = s.recv(65536)
        if not c: break
        buf += c; last = time.time()
    except:
        if time.time() - last > 3: break
open('/Users/jony/.openclaw/workspace/memory/home-control/lutron-158.xml', 'wb').write(buf[buf.find(b'<?xml'):buf.rfind(b'</Project>')+len('</Project>')])
print('wrote', len(buf), 'bytes')
"

# Then regenerate:
cd /Users/jony/.openclaw/workspace/projects/berg-castle-panel
node build-room-map.mjs
node build-picos.mjs

# Restart server
lsof -ti:4321 | xargs kill -9
nohup node server.js > /tmp/berg-panel.log 2>&1 &
```

**Note:** the `lutron / lutron` account is DBXML-read-only — it can dump the project but can't run `?OUTPUT` / `#OUTPUT` commands. The `josh / 1234` account is the one with full integration control.

---

## Cloudflare Tunnel + Access

**Tunnel:** `berg-castle` (uuid `979bab30-df98-4e08-915c-29f7b541bf6c`)
**Public URL:** `home.bergcastle.com` (subdomain of the Cloudflare-registered `bergcastle.com`)
**cloudflared service:** launchd user agent at `~/Library/LaunchAgents/com.cloudflare.cloudflared.plist`, running as `/opt/homebrew/bin/cloudflared --config /Users/jony/.cloudflared/config.yml tunnel run berg-castle`
**Access policy:** email `me@simonberg.ai`, 1-month sliding session
**Tunnel config:** `~/.cloudflared/config.yml`
**Tunnel credentials:** `~/.cloudflared/979bab30-df98-4e08-915c-29f7b541bf6c.json` (secret — keep off github)

If the tunnel dies:
```bash
launchctl unload ~/Library/LaunchAgents/com.cloudflare.cloudflared.plist
launchctl load ~/Library/LaunchAgents/com.cloudflare.cloudflared.plist
tail -f ~/Library/Logs/com.cloudflare.cloudflared.err.log
```

---

## Known limitations

**Music**

- **No catalog search without Spotify credentials.** See above — this is a Sonos S2
  architecture fact, not a gap in the panel. Apple Music search would need a paid
  Apple Developer account for a MusicKit token.
- **Three Sonos Favorites are "shortcuts"** (Discover Sonos Radio, Favorites, Trending
  Now). They carry an empty `res` and only exist as cloud browse entry points, so they
  are listed but not playable from here. The other ten favorites play fine.
- **Spotify search returns at most 10 results per type.** The API documents 50, but
  apps on the default quota tier get a 400 above 10. Paging with `offset` is the fix
  if it ever matters.
- **The local music library is empty** — no NAS share is indexed on the household, so
  the library browse sections are hidden rather than shown empty.

- **Programming can't be changed via telnet.** The `josh` integration user can *run* the system but not *reprogram* it. To add scenes to physical Picos, rename loads in Lutron, or add new keypad wiring, you need RadioRA2 Essentials software on a PC → Retrieve → edit → Transfer. The software on Simon's PC is v12.10.0 (April 2021) and currently can't retrieve because Lutron firmware has moved forward. Newer version needed from the Lutron dealer portal.
- **App-level renames don't propagate back to Lutron.** All names Simon changed ("Sun Room" → "Kids Lounge", "Bedroom Hall" → "Hallway", the fireplace redistribution, etc.) are only in `rooms.js`. Lutron still sees the original programming.
- **Persistence relies on `jony` user staying logged in.** The Mac must stay powered on and the `jony` user session active. If Mac reboots and no one logs in, tunnel + panel both die. For headless 24/7 we'd need a system-level LaunchDaemon.
- **No editing of app-level structure from UI.** Adding new zones, moving rooms, renaming outputs — all edits are code changes in `rooms.js`, restart the server. TODO: an admin/customize screen.
- **No custom scenes editor.** Synthetic scenes are hard-coded in `synthetic-scenes.js`. TODO: UI to save "current state" as a scene.
- **Access to the Josh Nano microphones is not yet implemented.** Reverse engineering is on hold — see `memory/home-control/berg-castle-network.md` for the state of the Nano protocol investigation.

---

## Credits

Built by Jony (Simon's AI creative director) and Simon Berg on 2026-07-30 in a single session. Josh.ai API cracked, Lutron RadioRA2 integration reverse-engineered, full house mapped, public app shipped, PWA installed on Simon's phone — all in one afternoon.

_"HOLY FUCK BALLS!!! Its working perfectly!!!"_ — Simon Berg, ~4pm ET
