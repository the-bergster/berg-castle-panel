# Berg Castle Panel — how this came to exist

_2026-07-30, single session, Sherman CT + Slack #jony-network-party_

## 2026-08-17 — Owner-only admin panel + one-tap entry (Cloudflare Access user provisioning)

**Context:** Simon asked for a slicker way to provision new house users than hand-editing the Cloudflare Access policy. Green-lit "basic scope, with a view to holding more," plus an elegant one-click way in — he couldn't reach the `/admin` URL from the installed PWA.

**Same session, earlier:** gave the voice agent a name. `voice.js` system prompt now opens "You are Jony, the voice of Berg Castle…" and tells it to answer "Jony" if asked who it is. (Separate agent from me — shares the name, not the memory.)

**What got built:**
- **`admin.js`** — owner-gated backend module. Every `/api/admin/*` route checks the `Cf-Access-Authenticated-User-Email` header CF injects on the authenticated tunnel; only `me@simonberg.ai` passes (others get 403). Routes: `GET /whoami`, `GET /users`, `POST /users` (add), `DELETE /users` (remove). Loads the CF admin token from `.secrets/cloudflare/berg-castle.env`. A loopback-only `ADMIN_ALLOW_LOCAL=1` dev bypass exists for testing; it never triggers behind CF.
- **`public/admin.html`** — standalone dark page matching the panel's design tokens. Lists current access, invite field, per-guest Remove, owner badge (owners can't be removed). Self-contained; no dependency on the SPA bundle.
- **Hub gear ⚙️** — `public/app.js` adds a gear button in the hub header that's hidden by default and only revealed after a `/api/admin/whoami` check confirms the owner. One tap from the PWA home screen → `/admin`. CSS in `public/app.css` (`.hub-gear`, `.hub-head-actions`).
- **`server.js`** — requires `admin`, serves `/admin`, delegates `/api/admin/*`.

**The gotcha (caught by smoke test):** the "Household" policy is a *reusable* (account-level) Access policy. Writing it through the app-scoped endpoint `/access/apps/{app}/policies/{id}` returns CF error **12130** (`can not update reusable policies through this endpoint`). Fix: use the account-level reusable endpoint `/access/policies/{id}` for both GET and PUT. Policy id is the same (`034b8d96-…`); only the path differs. Reads worked on the old path, writes didn't — exactly the kind of half-broken that only shows under a real write.

**Verified:** full add→remove round-trip against the live CF policy — added a throwaway address, CF accepted, removed it, list returned to exactly `me@simonberg.ai` + `dovile.berg@gmail.com` with no residue. Restarted via launchd, `/admin` serves 200.

**Future-facing:** `/admin` is built to extend (tunnel health, restart, recordings can drop in beside Users). The `/api/admin/users` endpoint also makes a future guarded `provision_user` voice tool one step away — kept out for now; would gate it confirm-only so a spoken "add Dave" can't silently grant house access.

**Commit:** `6a4e926` on `the-bergster/berg-castle-panel`.

## 2026-08-02 (evening) — Merge `sonos-parity` (Opus 5.0) into intercom branch

**What arrived:** Opus 5.0's `sonos-parity` branch, built from `3af8046` in parallel with the intercom work. 5 commits, 24 files, +7332/−539. Full rewrite of the Sonos half:
- `sonos.js` (flat, IP-sweep-based) replaced by `sonos/` (topology-aware modular subsystem: `topology.js`, `player.js`, `library.js`, `events.js`, `device.js`, `soap.js`, `search.js`, `didl.js`, `presets.js`, `api.js`).
- Topology now sourced live from `GetZoneGroupState` — the phantom "Sub" room and duplicated coordinators for bonded pairs disappear.
- Group-coordinator routing rule enforced everywhere: transport + queue to the coordinator, volume + EQ to the individual player.
- GENA event push instead of polling (fell back to polling if callback host isn't reachable). Boot line: `[Sonos] GENA: 40/40 subscriptions established` + `live updates via GENA push`.
- Spotify Web API bridge for catalog search (S2 firmware locked local search endpoints).
- Queue management, grouping, album art, per-model EQ, sleep timers, line-in, TV-input restore, real 19-room / 17-group live view.
- Album art proxied through `/api/sonos/art?u=...`. Now-playing per room with progress ticked client-side at 60fps between server updates.

**Merge conflicts, resolved:**
1. `.gitignore` — combined `/recordings/` from intercom with `sonos-config.json` + `.secrets/` from parity.
2. `public/app.css` — both branches independently arrived at the same scroll fix (`overflow-x` on `body` only, off `html` and `#app`). Took parity's version, better comments.
3. `public/app.js` — router (kept `/intercom` route alongside `/music`), Hub tile paint (took parity's `paintHubMusicTile()` approach which avoids the re-render loop I patched earlier), and dropped my inline `renderMusic`/`SONOS`/`fetchSonos` etc. in favour of the new `Music` module in `public/music.js`.
4. `server.js` — imports: kept parity's `SonosSystem` + `sonos/api`, added `intercom`.
5. `sonos.js` — deleted (parity replaced it with the `sonos/` directory). `require('./sonos')` now resolves to `sonos/index.js`.

**Retired:** `sonos-rooms.json` (static IP sweep, no longer read anywhere) and `discover-sonos.mjs` (the script that built it). Live topology from `GetZoneGroupState` is authoritative.

**New adapter:** `sonos/intercom-bridge.js`. The Intercom feature needs raw per-player transport commands (each target zone becomes independent for the duration of a message, then rejoins its group during restore). Bridge exposes `playerFor`, `captureState`, `playAnnouncement`, `restoreState` on top of `sonos/device.js`. Server's `/api/intercom/broadcast` now uses `sonos.intercom.*` instead of the retired flat SOAP client.

**Verified end-to-end after merge:**
- Boot output matches Opus's expected healthy start: 19 rooms in 17 groups, Spotify linked, GENA 40/40, push mode.
- `/api/sonos/search?q=hozier` returns 10 tracks, first is "Too Sweet — Hozier".
- `/api/sonos/favorites` returns 13 items.
- Intercom broadcast to Butler: captured pre-state (STOPPED, vol 22) → broadcast at vol 20 → restored to STOPPED at vol 22. Works over the new adapter.
- Puppeteer screenshots confirm all four routes render (Hub with 3 tiles, Music with 19-room grid + album art + now-playing bar, Intercom with room checkboxes + restore toggle, Lights unchanged).

**Spotify credentials:** copied `sonos-config.json` (with real client_id/client_secret) into repo root, `chmod 600`. Verified gitignored before commit. `sonos-config.example.json` remains the committed template.

**Sourced files:** the `sonos/` subsystem was authored by Opus 5.0 on Simon's Mac and delivered as a git bundle (`sonos-parity.bundle`, 5 commits, complete history). Merge preserved full authorship in the merge base.

## 2026-08-02 (later, still `feature/intercom`) — Restore previous audio

**What shipped:**
- `sonos.captureState(ip)` → snapshots `{ state, volume, track_uri, track_metadata, position }` before we hijack a zone.
- `sonos.restoreState(state)` → puts everything back: SetAVTransportURI + Seek to saved position + SetVolume + Play (only if it was PLAYING before). Group-follower URIs (`x-rincon:...`) survive intact so grouped zones rejoin their group.
- Broadcast endpoint now:
  1. Captures each target zone's state before firing
  2. Broadcasts the recording
  3. Schedules restore at `duration_ms + 800ms` buffer via `setTimeout().unref()`
- Client: green iOS-style toggle on the intercom screen, ON by default: *"Restore previous audio — Resume whatever was playing when the message ends."* Sends `restore: <bool>` to the API.
- `intercom.js` now calls `ffprobe` on the transcoded MP3 to store `duration_ms`, which the server uses to time the restore precisely.

**Verified end-to-end just now against 3 different priors:**
- *Butler* (STOPPED, no URI, vol 22) → broadcast at vol 18 → restored to STOPPED at vol 22. ✅
- *Grill Patio* (PLAYING as group-follower, vol 41) → broadcast at vol 18 → restored to PLAYING same group, vol 41. ✅
- *Kitchen* (STOPPED with Spotify track pre-loaded, vol 37) → broadcast at vol 18 → URI restored to same Spotify track, vol 37, still STOPPED. ✅

**Edge cases handled:**
- No prior URI → leaves zone STOPPED at original volume.
- Radio streams that reject Seek → caught and ignored, playback still resumes.
- Individual restore failures → logged, don't block other zones.
- `restore: false` explicit opt-out supported.

## 2026-08-02 (evening, branch `feature/intercom`) — Intercom tile + walkie-talkie broadcast

**What shipped:**
- New Hub tile: *Intercom* (red mic icon).
- `#/intercom` route with a full broadcast UX:
  - 2-column pill grid of all 19 Sonos zones, tap to select/deselect. `All` / `None` shortcuts.
  - Volume slider (0-100) that applies to every target zone right before broadcast.
  - Big round red *Record* button: tap-to-start, tap-to-stop. Pulses while recording, timer counts up in `MM:SS`.
  - On stop, blob is uploaded to `POST /api/intercom/record`; server transcodes to MP3 with ffmpeg and returns metadata.
  - `Send to N` primary action + `Discard` secondary. Send calls `POST /api/intercom/broadcast` with `{ recording_id, rooms, volume }`; server sets volume + `SetAVTransportURI` + `Play` on each target Sonos coordinator in parallel.
- `intercom.js`: recording storage (`/recordings/<uuid>.mp3`, prunes to last 20), LAN-IP auto-detection so Sonos speakers can reach the panel URL, ffmpeg transcode from any browser-recorded format (webm/opus, mp4/aac, ogg) to Sonos-safe MP3.
- `server.js`: `GET /recordings/:file`, `POST /api/intercom/record` (binary body), `POST /api/intercom/broadcast`.
- Fixed a pre-existing infinite-render loop on the Hub caused by a `fetchSonos().then(renderHub)` cycle; now only refetches on first visit.

**Verified end-to-end just now:**
- Generated a 2s sine-wave `.webm` via ffmpeg, POSTed to `/api/intercom/record` → got back a valid MP3 URL.
- Broadcast to Dining Room via `/api/intercom/broadcast` with `volume: 25` → `snapshot()` immediately showed `Dining Room` at vol 25 with `track_uri = http://192.168.2.82:4321/recordings/<id>.mp3`. Simon literally heard a beep in the Dining Room.

**Not shipped yet, deliberately:**
- Broadcast history / re-broadcast. First release is single-shot.
- Group-based presets ("Kids areas", "Main floor"). Requires floor/area tagging in `sonos-rooms.json`.
- Restore-previous-audio behaviour. Right now the broadcast leaves the target zone at STOPPED after the MP3 finishes; if there was music playing before, it's not resumed. Worth adding once the base UX is validated.

## 2026-08-02 (later) — Music tab goes real: live Sonos control

**What shipped:**
- `discover-sonos.mjs` — sweeps `192.168.4.100-199` for Sonos ZonePlayers, parses `device_description.xml` on `:1400`. Result cached to `sonos-rooms.json`. Discovered 22 devices across 20 rooms in <2s.
- `sonos.js` — dependency-free SOAP client for the ZonePlayer local control protocol. Wraps `RenderingControl:1` (volume/mute), `AVTransport:1` (play/pause/stop/next/prev, GetTransportInfo, GetPositionInfo, SetAVTransportURI), and `ZoneGroupTopology:1`. Includes `snapshot()` → fan-out fetch of all rooms in parallel (~130ms for 19 rooms).
- `server.js` — 3 new routes:
  - `GET  /api/sonos/rooms`      → room → IP map + quick-stream presets
  - `GET  /api/sonos/snapshot`   → per-room live state (volume, transport state, now-playing title/artist)
  - `POST /api/sonos/command`    → play, pause, stop, next, previous, volume, mute, play_stream
- `public/app.js` — real `renderMusic()` view. Live room grid with:
  - Play/pause button per room (round, tints blue when playing)
  - Volume slider (0-100, optimistic UI, commits on change)
  - Now-playing card (title + artist/streamContent) when a real track is loaded
  - 4 quick-play stream chips per room: Jazz, Chill, Ambient, Classical (SomaFM URLs, the format we confirmed works during the network-party session)
  - Card border/background tints blue when the room is playing
  - Polls `/api/sonos/snapshot` every 4s while on `#/music`
- Hub `Music` tile now shows live counts ("3 playing · 19 zones") with a blue count badge when anything is playing.

**Verified end-to-end:** Butler volume round-trip via curl (22 → 15 → 22, all reflected in `/api/sonos/snapshot`). Puppeteer screenshots at 390×844 show 3 rooms playing on the live network at capture time (Grill Patio, Playground, Pool), each rendered with correct state + track title.

**Deliberately not (yet):**
- Grouping / party-mode (drag-to-group). Sonos groups work via `ZoneGroupTopology` + `SetAVTransportURI` with a `x-rincon:<coordinator-uuid>` URI on the followers — planned as next slice.
- Streaming service picking (Spotify, Apple Music). Requires OAuth per service. Skipped for MVP.
- WebSocket push for Sonos state changes. Currently polling. Sonos supports GENA event subscriptions (SUBSCRIBE HTTP verb on the service endpoints); worth wiring when polling load becomes an issue.

## 2026-08-02 — Hub landing + Music tab stub

**What changed:**
- New landing page at `#/`: Hub with two tiles, Music (blue) + Lights (amber). Lights tile shows live "N on · M rooms" count and an amber count badge when lights are on.
- Lights view moved to `#/lights` (was `#/`). Room detail routes unchanged at `#/room/:id`.
- Music view added at `#/music` — Sonos placeholder screen with big icon, copy explaining the plan ("Built on Sonos's official Control API"), and a status pill ("Dining Room verified · TTS working").
- Chevron back buttons on both Lights and Music → Hub.
- CSS: `.hub-grid`, `.hub-tile`, `.hub-tile-icon/-body/-title/-sub/-badge`, `.music-empty` classes added. Reused existing `.topbar-back` for back nav.

**Why now:** Simon asked (after we agreed *not* to fork the sonos-web/sonos-web repo — it's cold, SOAP/UPnP-based which broke on Sonos S2 firmware, GPL v3) to lay the shell so that Sonos control lives *under* a Music tile in the main Berg Castle app. Foundation for wiring up Sonos's official Control API next.

**Verified:** Puppeteer screenshots at iPhone 390×844 confirm all three routes render with LIVE badge, correct margins, and consistent tile language across Hub → Music and Hub → Lights.


## The trigger

Simon mentioned that Max, his nephew, had asked his agent to explore the local network and look for controllable devices. Simon asked me to try the same.

## What we found

Within 20 minutes:
- 22 Sonos speakers (all named zones — Master Bath, Kitchen, Pool, Grill Patio, Butler, Sauna & Steam, Playground, Kids Playroom, etc.)
- 31 AirPlay targets
- 9 Ecobee thermostats
- Sony XR-65A80J OLED TV
- HP printer / scanner
- Ruckus wifi controller
- OpenClaw gateway (me on the other node)

## First win — playing jazz in the Dining Room via Sonos SOAP

Confirmed I could hit Sonos control API on port 1400 unauthenticated. Set volume 30, played SomaFM Sonic Universe. Stopped it. That was the "holy shit" moment.

## Josh.ai — the middleware

Simon revealed he had Josh.ai installed with Josh Nano mics in every room + a Josh Core central processor. Subscription lapsed, dashboard dead. He hated it. Wanted to know if we could bypass it entirely.

I initially recommended replacing Josh's mic hardware — Simon pushed back hard: "the Nanos are just PoE microphones, they aren't intelligent, they must talk to Core somehow — figure it out."

We found:
- Josh Core at 192.168.2.227 (MAC F8:8A:3C:70:E4:33 confirmed from Simon's photo of the physical unit)
- 10 Josh Nanos on 192.168.2.x (F8:8A:3C:70:4B/4E/4F/51:xx MAC pattern)
- Josh Core runs Debian Linux with SSH, Telnet, HTTP/HTTPS, and Home Assistant on port 8123

## Josh API cracked

Josh Core exposes an unauthenticated JSON API on port 443/HTTPS at `/josh`. Post a natural-language command:

```json
{"joshseq":"dojosh1","human":"turn on the dining room light","jsid":"general","userid":0}
```

Josh executes it against every dealer-configured integration (Lutron, Sonos, Roku, WattBox, TVs) and returns a `controller` array with deviceset IDs. No subscription, no auth on LAN. This became our first control path.

## Lutron discovered

From Josh's device inventory: 2 Lutron RadioRA2 hubs. I found them at 192.168.2.158 and 192.168.2.225. Both open Telnet on port 23.

**First attempt:** `lutron / lutron` — logged in but every command silently ignored except `?SYSTEM,12`, which returned a 700KB XML dump of the entire project database. Read-only DBXML export account, no runtime control.

We banked the full XML — every room, every load, every keypad button assignment, all scene programming. **114 controllable outputs across 37 rooms.**

## The Lutron software detour

Simon fired up the PC to look at the Integration settings in RadioRA2 Essentials software. Two-year-old install. Wi-Fi wasn't good enough — I told him this was a known issue, he wired in via ethernet, still couldn't retrieve because his software was too old for the current processor firmware.

**But we didn't need to retrieve** — Simon opened his locally-saved project instead and screenshot the Integration → Telnet Login panel. That's where he saw:

- **`josh` / `1234`** — the credential Josh uses to drive Lutron.

I tested it immediately. `#OUTPUT,62,1,50.00,00:00:01` — Office Recessed dimmed to 50%. **We were in with full direct control, at Pico-native speed, bypassing Josh entirely.**

## The build

Once direct Lutron worked, we built up in ~90 minutes:

1. Persistent Node.js Telnet client with `#MONITORING,255,1` streaming live events
2. WebSocket server pushing state changes to browsers in real time
3. Home view with room tiles grouped by zone
4. Room detail view with per-output sliders
5. Scene chips wired to virtual Pico presses (`#DEVICE,<pico>,<btn>,3`) for repeater-native speed
6. Cloudflare Tunnel + Access for public HTTPS access
7. PWA manifest so it installs to iPhone home screen

## Simon's UX passes

Simon gave design feedback and I iterated:

- Main House had 17 rooms → split into Dining, Kitchen, Offices, Entryways, Living, Upstairs Hall, Utility
- Sun Room → soft-renamed "Kids Lounge"
- Fireplaces (Lutron's cross-cutting room) → 4 outputs distributed into their actual physical rooms (Office / Dining Room / Side Foyer / Master Suite)
- Reading Nook + Bedroom Hall + Hall Bathroom + Stairs Bathroom grouped into new "Upstairs Hall" zone
- Office 2 → "Office Equipment"
- Dovile Office moved from Bedrooms to Offices
- Dining Room `#59 Receesed` typo → `Recessed`
- Bedroom One `#34 Pedant` typo → `Pendant`
- Master Suite `#9 Sitting Recesssed` typo → `Sitting Recessed`
- Kitchen `#70 ?` dead switch → hidden
- Extractor Fan Kitchen room merged into Kitchen (single-output orphan)
- Scenes strip curated: Welcome / Comfortable / Magic / House off removed on Simon's request
- "Hall on" and "Hall off" Pico scenes added to the strip

## Simon's phone moment

After deploying, tunnel live at `home.bergcastle.com`, Access wall auth working with `me@simonberg.ai`, PWA installed on his iPhone:

> "HOLY FUCK BALLS!!! Its working perfectly!!!"
>
> "You are a genius!!!"
>
> "the speed differance is off the charts"
>
> "AMAZING!!!! LOVE IT!"
>
> "This is so fucking cool!!"

## 2026-07-31 — The berg-castle-panel outage, the Sonos broadcast, and the JMNP protocol capture

The morning after the initial build. Multiple threads in one session:

### 07:30 EDT — Panel outage postmortem + hardening

Simon woke to a Cloudflare "unstable" screen on the phone app. Root cause: the plain `node server.js` had died silently overnight. Not memory, not jetsam, not a signal — no crash report at all. Which is the fingerprint of an **unhandled promise rejection or async exception** killing Node without a trace.

Code audit found the smoking gun: `lutron.js` `pressPicoButton()` writes to the Telnet socket from inside a `setTimeout` callback with no try/catch. If the socket died in that 100ms window, the sync throw would kill the process. No `process.on('uncaughtException')` handler anywhere in the codebase.

Shipped in one commit (`076871c`):
- `process.on('uncaughtException' | 'unhandledRejection' | SIGTERM | SIGINT)` handlers in `server.js` so future failures leave a timestamped stack in the logs instead of dying silently.
- `pressPicoButton` writes wrapped in try/catch, with socket-identity + `destroyed` guards on the delayed release write.
- `deploy/com.simon.berg-castle-panel.plist` — a LaunchAgent with `RunAtLoad=true`, `KeepAlive.Crashed=true`, `ThrottleInterval=10s`. Copy to `~/Library/LaunchAgents/` and `launchctl load -w` to install. Verified: killed the process with `kill -9`, launchd respawned it in <1s.
- Watchdog cron (isolated OpenClaw job) checks `http://localhost:4321/` every 5 minutes and DMs Simon after 2 consecutive failures / on recovery.

Simon locked in a new workspace rule from the incident: **every code change ends with `git push`.** The `0a5ba8b` scenes commit from yesterday had been sitting local-only for 24 hours; today's fix nearly did the same. Rule now in `AGENTS.md` at the top.

Also: added `jony-rhapsody` as a Write collaborator on `the-bergster/berg-castle-panel` so future pushes don't need Simon-in-the-loop.

### 12:40 EDT — First TTS broadcast to a Sonos zone

"Can you use 11labs to create an audio file that says 'Hello Max and Simon, this is Jony in your house' and then broadcast that sound through the sonos speakers in the dining room?"

End-to-end path:
1. Rediscovered the Sonos fleet via SSDP scan (22 ZonePlayers on `192.168.4.x`, matched yesterday's list).
2. Pulled each device's `roomName` from `http://<ip>:1400/xml/device_description.xml`. Dining Room = `192.168.4.161` (Sonos Amp).
3. ElevenLabs REST call to generate a ~4-second MP3. Note: the voice ID in `TOOLS.md` (`pIX7ZNqBMOeINOOOHKAw`, "Jony's voice") is not on this account. Fell back to the default configured in `openclaw.json`: `iP95p4xoKVk53GoZ742B` = "Chris — Charming, Down-to-Earth." TODO reconcile the voice ID mismatch.
4. Stood up an ephemeral `python3 -m http.server 8765` on the Jony Mac (`192.168.2.100`) to serve the MP3.
5. Sonos SOAP: `GetVolume` (30) → `SetVolume` (45) → `SetAVTransportURI` (the MP3 URL) → `Play` → poll `GetTransportInfo` until STOPPED → `SetVolume` (30) to restore.

Worked first try. Simon confirmed hearing it out loud. Full script cached at `/tmp/berg-broadcast/play.py` for reference — next step is folding this into the panel as a proper `/api/broadcast` endpoint, but Simon parked that: he's thinking about building a realtime voice layer above me (GPT-Voice-style) rather than one-shot batch TTS.

### 14:10 EDT — Josh Nano reconnaissance via packet capture (planned last session, executed today)

Simon plugged an ethernet cable into the Jony Mac (so I could drive tcpdump directly), and I ran a 90-second capture on `en7` = `192.168.2.175` while he woke a few Nanos.

The Nanos are VLAN-isolated — their unicast traffic never reached the main LAN so we didn't capture wake-word audio. But **the Josh Core (`192.168.2.227`) is on the main LAN and broadcasts every 5 seconds in the clear**. That gave us the crown jewels:

**JMNP — Josh's proprietary network protocol.** Plain JSON over UDP to `255.255.255.255:55055`. Every 5 seconds the Core shouts its identity, license key, hardware type (`secondary.core` — there's a primary somewhere), software version, and building-config sequence number. Zero encryption. Full field-by-field breakdown in `~/.openclaw/workspace/memory/home-control/josh-jmnp-protocol.md`.

Secondary discovery via **mDNS on `_josh-core._tcp` port 9121**. The Core's mDNS advert carries an inventory of every device it knows about, including the six Nanos by MAC-ish jsid + room name (Dining, Lounge, Master Bedroom, Guest Bedrooms, Simons M3, Kitchen) and every Sonos player. Also revealed a `Josh Nimble` device I hadn't seen before.

**The site license key was in the capture** (broadcast in cleartext every 5s). Stashed at `.secrets/josh/josh-license.env` on the Jony Mac. Treat as a credential — anyone broadcasting JMNP with a matching license would (hypothesis) be accepted as a peer. Value redacted from this file after Simon's push (repo is private but private ≠ secret).

Simon's steer at end of session: **document first, then get on the Ruckus switch for port mirroring, then long-running capture during real voice activity to catalogue all `messageType` values.** No spoofing/impersonation attempts until we have a rollback plan.

---

### 18:30 EDT — Kofi call: network admin creds unlocked, full house mapped

Simon jumped on the phone with Kofi (used to be on the team that installed the original Berg Castle setup; lost dealer access ~4 months ago and is working on regaining it). Kofi handed over admin credentials for:

- **Araknis router (192.168.2.1)**
- **Ruckus ZoneDirector (192.168.2.5)**

Both verified live. I also spotted two OvrC Wattbox PDUs (`192.168.2.6` and `.7`) still on factory defaults — those never got changed. All credentials stashed at `.secrets/berg-castle-network/creds.env` (chmod 600, never in chat or git — including this file).

Then used the Araknis REST API (`GET /api/cgi-bin/v1/status/clients-services`) to pull the complete DHCP client table — **103 devices** — which finally gave us:

- **The real VLAN topology:** VLAN 1 "Frontier" (`.2.x`) is the main LAN; VLAN 2 "Voice" (`.4.x`) is Sonos; VLAN 3 "Guest" (`.3.x`) is guest Wi-Fi. Yesterday's "Nanos are on a separate VLAN" theory was wrong.
- **All 10 Josh Nanos on `.2.x`** — same subnet as my Mac. They were invisible before because the downstream **Araknis Switch2 (`192.168.2.3`)** enforces client isolation. Nanos can reach Core and the gateway but not each other or my Mac. TCP probes on all 10 Nanos (36 ports each) returned zero open ports — Nanos are pure clients, no local API surface.
- **Newly discovered devices:** Araknis Switch2 (the managed fan-out switch), Luma NVR at `.11`, a third Wattbox PDU at `.110`, a second Lutron device at `.225` (sibling MAC to the main RadioRA2), 9 Ecobee thermostats by room name, 7 Ruckus APs, 8 Rokus.

**Blocker now narrowed to one target:** **Araknis Switch2 admin at `192.168.2.3`**. That's the box with the Nano PoE ports and is the port-mirror target for finally capturing Nano → Core audio. Same credential family as the router probably works; Kofi hasn't confirmed yet.

**Josh Core SSH still unbroken.** Simon tried a few candidate passwords — all denied across every plausible username (root/admin/josh/dealer/installer/svc/ubuntu/debian/pi/simon/berg/etc.). Hypothesis: those creds are for the Josh cloud/dealer portal, not the Debian box's SSH. Kofi's regained dealer access is the likely path when he gets it.

All updates rolled into `memory/home-control/berg-castle-network.md` + `josh-jmnp-protocol.md` + MEMORY.md. Full protocol notes and inventory locked in before we go poking at Switch2.

---

## What we didn't do (yet)

- **Araknis Switch2 admin login** — the ONE remaining blocker for Nano-side traffic capture. Suspected same credential family as router (untested at time of this write-up).
- Josh Nano audio-path capture — requires Switch2 port mirroring.
- Josh Core SSH shell — all Simon's `OMEGA`/`Al0ng...` creds denied. Waiting on Kofi's dealer access.
- Josh Core SSH shell — `qoreamadeus` password didn't work, `wattbox:wattbox` on the WattBox strips got us to a "set default password" screen but we didn't force through.
- Araknis router (192.168.2.1) admin — `qoreamadeus` didn't work.
- Luma NVR — isolated camera VLAN, unreachable from this network position.
- Custom scenes editor in the panel (build your own scenes from current state).
- Schedules (fire scenes at sunset, etc).
- Sonos + Ecobee integration into the panel.

## Architectural takeaway

The endgame won't be "Lutron app" or "Josh app" — it's this panel, integrating Lutron + Sonos + Ecobee + eventually Luma cameras and Josh Nano mics — a single Berg Castle app that owns the whole house at direct-hardware speed, works over the internet, feels native. Today we hit the lights + scenes milestone. Everything else stacks on top of the same architecture.

---

## 2026-08-02 — Sonos: from stub to feature parity

Simon handed the Music tab over with the Lutron side already flawless. The Sonos half
was a working stub: a list of rooms, play/pause, a volume slider and four SomaFM chips.
This session took it to something that stands next to the real Sonos app.

### The thing that was quietly broken

`sonos.js` read `sonos-rooms.json` — a snapshot from an IP sweep — and sent every command
to the room's own IP. That works right up until two rooms are grouped, and at the time
of writing Pool + Grill Patio + Playground were grouped and playing. In that state:

- Pool reported no track at all, because Pool is not the coordinator; Playground is.
- Transport commands aimed at Pool would fail with UPnP 1023 or split the group.
- The sweep had also invented a phantom room called "Sub" (the Master TV's bonded
  subwoofer answers `device_description.xml` on its own IP) and given Lounge and
  Master TV two "coordinators" each (their bonded surrounds do the same).

The fix is to stop guessing and ask the household: `GetZoneGroupState` returns the whole
topology from any single speaker, with bonded satellites nested as `<Satellite Invisible="1">`
so they fall out naturally. 19 real rooms, live grouping, correct coordinators.
`sonos/player.js` now owns the one rule that matters: **transport and queue go to the
group coordinator, volume and EQ go to the individual player.**

### Search: the interesting dead end

Spent real effort trying to make the players search their own catalogs. They cannot,
and it is worth writing down exactly how that was established:

- `GetSearchCapabilities` → empty string
- UPnP `Search` → UPnP 401, not implemented
- Browsing a third-party service container, using an ID lifted from Simon's *own*
  Apple Music favourite, in ten encodings → UPnP 701 every time
- `GetSessionId` for Spotify (12) and Apple Music (204) → UPnP 806
- `/status/accounts`, the endpoint SoCo used to read service tokens on S1 → empty on S2
- Local library `A:ALBUM` / `A:TRACKS` → 0, no NAS share indexed

On S2 Sonos moved catalog browse and search into their cloud. The speaker is a playback
endpoint: hand it a URI and it plays, but it will not tell you what exists.

So the panel does what Sonos's cloud does — searches Spotify's API itself and synthesises
the URI and DIDL metadata. Simon created a free Spotify app mid-session. The formats were
derived from his own favourites and queue rather than from folklore:

```
track     x-sonos-spotify:spotify%3atrack%3a<ID>?sid=12&flags=8232&sn=7
album     x-rincon-cpcontainer:1004204cspotify%3aalbum%3a<ID>?sid=12&flags=8268&sn=7
playlist  x-rincon-cpcontainer:1006206cspotify%3aplaylist%3a<ID>?sid=12&flags=8300&sn=7
desc      SA_RINCON<sid*256 + 7>_X_#Svc<sid*256 + 7>-0-Token
```

That `sid*256 + 7` rule was checked against three services in his household —
Spotify 12→3079, Apple Music 204→52231, Sonos Radio 303→77575 — before being trusted.
The metadata item id turned out to be `1003`/`1004`/`1006` followed by the flags value
in hex. `sid` and `sn` are now read off live content at startup, so re-linking Spotify
cannot silently break playback.

The decisive test was silent: enqueue a searched track on the Lounge (which was on TV,
so nothing was interrupted) and see whether the *player* resolves it. It came back
"Miles Davis · Kind Of Blue (Legacy Edition) · 9:22" with real album art — the speaker
had gone to Spotify and looked it up, which only happens for a well-formed URI.

### Real-time

The players push state to us now instead of being polled. Our server exposes a NOTIFY
endpoint and subscribes each player's AVTransport and RenderingControl to it, plus
ZoneGroupTopology and ContentDirectory once for the household — 40 subscriptions.
This was not a given: the speakers sit on VLAN 2 and the server on VLAN 1, so
reachability is *verified* at startup by waiting for the initial NOTIFY, with a
transparent fall back to adaptive polling if it never arrives. It arrived: 40/40.

### Bugs found by looking at the screen

- A stopped player still reports whatever it last held, so idle rooms were advertising
  stale TTS filenames like `0e87edab84b1.mp3` as if they were playing.
- The Lounge Arc on TV audio read as "Idle" while audibly playing.
- Internet radio reports its stream mount (`groovesalad-128-mp3`) as the track title.
- `connectWS()` opened a fresh socket on every render without closing the old one. One
  browser tab had the server logging 50+ connected clients; each broadcast went out
  once per render since page load. Pre-existing, now idempotent.
- Sonos sometimes serves a queue entry with nothing but a res URI and album art — no
  title, no artist. The track id is still in the URI, so those rows are now repaired
  from Spotify. (Its *batch* `/v1/tracks?ids=` endpoint answers 403 under Client
  Credentials while the single-track endpoint works; and search `limit` is capped at
  10, not the documented 50, on the default quota tier. Both found the hard way.)
- `NrTracks` is not the queue length. It describes whatever is loaded — it reads 1 when
  the transport points at a single track, even with 100 tracks in the room's queue.

### Verified against the live house

Reorder arithmetic both directions (the `InsertBefore` off-by-one) on the Lounge's empty
queue; stream, container and next playback audibly on the Workshop at volume 8, restored
clean each time. The Pool group was never touched — Dovile and her friends were out there.

### Still open

- Apple Music search would need a paid Apple Developer account for a MusicKit token.
- Three favourites are cloud "shortcuts" with an empty `res` and are listed but not
  playable from here.
- Ecobee, cameras and the Josh Nano mics remain untouched.
