# Berg Castle Control Panel

Personal home-control web app for Simon Berg's home in Sherman, CT ("Berg Castle").
Talks directly to Lutron RadioRA2 processors over Telnet, bypasses Josh.ai entirely
for lights, and streams live state via WebSocket. Hosted on the Jony Mac, exposed
publicly via Cloudflare Tunnel + Cloudflare Access, installable as a PWA.

**Built** 2026-07-30 in a single ~10-hour session between Simon and Jony (his creative-director AI). See `HISTORY.md` for the story of how this got built (Sonos → Josh API crack → Lutron reverse engineering → this app).

---

## What it does

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

---

## Files

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
