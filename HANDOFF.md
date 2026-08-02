# Sonos parity branch — handoff

> Readable without merging anything:
> `git show sonos-parity:HANDOFF.md`
>
> Delete this file once the branch is merged — it describes a one-time handoff, not
> the project. Everything durable lives in `README.md` and `HISTORY.md`.

Rebuild of the Music half of the Berg Castle panel. 5 commits on a branch called
`sonos-parity`, based on `3af8046` ("Force no-store + version-bump index.html script/css tags").

**24 files changed, +7332 / −539.** Everything under `sonos/` and `public/music.*` is new.

This was built and verified on Simon's Mac (192.168.2.127), which can reach the Sonos
players but *cannot* reach the Lutron processor — so the Lights half is untested from
here and should be sanity-checked once it is on the Jony Mac.

---

## 1. Apply it

Preferred — a git bundle with complete history, so normal merge machinery works:

```bash
cd /Users/jony/.openclaw/workspace/projects/berg-castle-panel
git fetch /path/to/sonos-parity.bundle sonos-parity:sonos-parity
git merge sonos-parity          # or: git rebase main sonos-parity
```

The bundle is self-contained (no prerequisite objects), verified by cloning from it
into a scratch directory and running `node -c` over every module.

Fallback, if you would rather cherry-pick — `patches/` holds the same commits as
`git format-patch` output:

```bash
git am patches/*.patch
```

---

## 2. Expect exactly one conflict: `public/app.css`

Main has moved since this branch was cut. Commit `63596cd` fixed the scroll bug by
scoping `overflow-x` to `<body>`; this branch contains **the same fix**, made
independently before that commit was known here.

The two hunks are:

```css
/* html, body { ... }  — remove overflow-x from the shared rule */
body { overflow-x: hidden; }

/* and */
#app { width: 100%; max-width: 100vw; }   /* overflow-x removed */
```

**Take either side.** They are equivalent. If main's version is already in place,
resolve in favour of main and drop this branch's hunk — nothing else depends on it.

No other conflicts are expected. The Intercom route added on main is untouched here,
and `public/app.js` changes are confined to the router, the Hub's Music tile, and the
WebSocket handler.

### One thing to check after merging `public/app.js`

`connectWS()` is now idempotent. It used to open a fresh socket on every render
without closing the previous one — a single browser tab had the server logging 50+
connected clients, and every broadcast went out once per render since page load. If
main has since changed `connectWS`, keep whichever version returns early when the
socket is already `OPEN` or `CONNECTING`.

---

## 3. Credentials — needed for search, must not be committed

`sonos-config.json` in this folder holds Simon's Spotify app credentials. Copy it into
the repo root on the Jony Mac:

```bash
cp sonos-config.json /Users/jony/.openclaw/workspace/projects/berg-castle-panel/
chmod 600 /Users/jony/.openclaw/workspace/projects/berg-castle-panel/sonos-config.json
```

It is already in `.gitignore` (added by this branch, alongside `.secrets/`). Verify
before any commit:

```bash
git check-ignore -v sonos-config.json    # must print a match
```

`sonos-config.example.json` is committed as the template. `SPOTIFY_CLIENT_ID` and
`SPOTIFY_CLIENT_SECRET` environment variables override the file if you prefer that.

Without credentials everything still works — only the Search screen goes dark, with an
explanatory empty state rather than an error.

**Note:** these credentials passed through a chat transcript. Rotating them at
developer.spotify.com is cheap and only requires editing this one file.

---

## 4. Verify after applying

No `npm install` — Node built-ins only, same as the rest of the panel.

```bash
node server.js
```

Expected on a healthy start:

```
[Sonos] 19 rooms in 17 groups
[Sonos] Spotify linked as sid=12 sn=7
[Sonos] GENA: 40/40 subscriptions established
[Sonos] live updates via GENA push
```

If the third line says `polling fallback` instead, the players could not reach the
server's callback address. That is not fatal — the app degrades to adaptive polling
automatically — but it is worth knowing. The callback host is auto-detected from the
first private-range interface; on a machine with Tailscale up, confirm it picked the
192.168.x address and not the 100.x one.

Quick smoke test:

```bash
curl -s localhost:4321/api/sonos/state | head -c 200      # topology + all rooms
curl -s "localhost:4321/api/sonos/search?q=hozier"        # Spotify search
curl -s localhost:4321/api/sonos/favorites                # 13 favorites
```

**Rooms should come back as 19, not 20.** If it says 20 and includes one called "Sub",
something is still reading the old `sonos-rooms.json` sweep instead of live topology.

---

## 5. What changed, briefly

The load-bearing fix is topology. The old code read `sonos-rooms.json` (an IP sweep)
and sent every command to a room's own IP. That breaks as soon as two rooms are
grouped — and Pool + Grill Patio + Playground were grouped and playing during this
work: Pool reported no track at all, and transport commands aimed at it would have
failed with UPnP 1023 or split the group. The sweep had also invented a phantom room
called "Sub" and given Lounge and Master TV two "coordinators" each, because bonded
subs and surrounds answer `device_description.xml` on their own IPs.

Topology now comes from `GetZoneGroupState`. `sonos/player.js` owns the routing rule:
**transport and queue go to the group coordinator; volume and EQ go to the individual
player.** Confirmed the hard way — `GetGroupVolume` on a non-coordinator returns
UPnP 701.

New capability: queue management (reorder / remove / clear / save), grouping, album
art, per-model EQ, sleep timers, line-in, TV input, Spotify search, and real-time GENA
push instead of polling.

`sonos.js` is deleted and replaced by the `sonos/` directory — `require('./sonos')`
resolves to `sonos/index.js`, so the import in `server.js` is unchanged in spirit.
Make sure the old file is actually gone after merging, or Node will resolve to it.

Full detail is in the branch's own `README.md` and `HISTORY.md`.

---

## 6. Two things worth knowing

**Master TV is pointed at a leftover announcement MP3, not its TV input.** The TTS
system switched it and never switched it back. This branch adds TV as a restorable
source (`x-sonos-htastream:<uuid>:spdif`, captured live from the Lounge Arc rather
than guessed), so it can be fixed from the panel's per-room More sheet. Worth checking
whether the announcement code should restore the previous source itself.

**Catalog search cannot come from the players.** Verified against firmware 96.0-78270:
`GetSearchCapabilities` returns empty, the UPnP `Search` action returns 401, browsing
any third-party service container returns 701 for every ID encoding tried,
`GetSessionId` returns 806 for OAuth services, and `/status/accounts` is empty on S2.
On S2 that all lives in Sonos's cloud. Hence the Spotify Web API bridge.

---

## 7. Verified against the live house

- Reorder arithmetic both directions (the `InsertBefore` off-by-one) on the Lounge's
  empty queue
- Stream, container and next playback audibly on the Workshop at volume 8
- Grouping join / leave / group-volume on Workshop + Single Garage while both stopped
- GENA push: an externally-made volume change arrived unprompted, correctly attributed
- Spotify URI correctness: the *player itself* resolved a searched track to
  "Miles Davis · Kind Of Blue (Legacy Edition) · 9:22" with real album art
- Wheel scrolling on Music, Lights and Queue after the CSS fix

Every zone was restored to its prior state. The Pool group was never touched.
