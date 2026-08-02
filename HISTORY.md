# Berg Castle Panel — how this came to exist

_2026-07-30, single session, Sherman CT + Slack #jony-network-party_

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
