# Berg Castle Panel — how this came to exist

_2026-07-30, single session, Sherman CT + Slack #jony-network-party_

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

## What we didn't do (yet)

- Josh Nano mic reverse engineering — parked. Broadcast ports identified (56700 heartbeat, 55055 announcement). Full protocol capture needs port mirroring on the Ruckus switch or ARP-spoofing a Nano.
- Josh Core SSH shell — `qoreamadeus` password didn't work, `wattbox:wattbox` on the WattBox strips got us to a "set default password" screen but we didn't force through.
- Araknis router (192.168.2.1) admin — `qoreamadeus` didn't work.
- Luma NVR — isolated camera VLAN, unreachable from this network position.
- Custom scenes editor in the panel (build your own scenes from current state).
- Schedules (fire scenes at sunset, etc).
- Sonos + Ecobee integration into the panel.

## Architectural takeaway

The endgame won't be "Lutron app" or "Josh app" — it's this panel, integrating Lutron + Sonos + Ecobee + eventually Luma cameras and Josh Nano mics — a single Berg Castle app that owns the whole house at direct-hardware speed, works over the internet, feels native. Today we hit the lights + scenes milestone. Everything else stacks on top of the same architecture.
