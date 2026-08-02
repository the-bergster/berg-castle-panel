// sonos/player.js — High-level, topology-aware operations on rooms.
//
// Every method here takes a ROOM NAME and works out which device to talk to.
// That routing is the whole point of this file:
//
//   transport / queue  -> group coordinator   (wrong target => UPnP 1023 or a split group)
//   volume / mute / EQ -> the room's own player
//   group volume       -> group coordinator
//
// The old implementation sent everything to the room's own IP, which happened to work
// only because every room was ungrouped at the time.

'use strict';

const dev = require('./device');
const didl = require('./didl');
const X = require('./xml');
const { SonosError } = require('./soap');

/** Play modes, decomposed into the two independent toggles a UI actually shows. */
const PLAY_MODES = {
  NORMAL: { shuffle: false, repeat: 'none' },
  REPEAT_ALL: { shuffle: false, repeat: 'all' },
  REPEAT_ONE: { shuffle: false, repeat: 'one' },
  SHUFFLE: { shuffle: true, repeat: 'all' },
  SHUFFLE_NOREPEAT: { shuffle: true, repeat: 'none' },
  SHUFFLE_REPEAT_ONE: { shuffle: true, repeat: 'one' },
};

/** Inverse of PLAY_MODES: (shuffle, repeat) -> the mode string Sonos expects. */
function toPlayMode(shuffle, repeat) {
  if (shuffle) {
    if (repeat === 'one') return 'SHUFFLE_REPEAT_ONE';
    if (repeat === 'all') return 'SHUFFLE';
    return 'SHUFFLE_NOREPEAT';
  }
  if (repeat === 'one') return 'REPEAT_ONE';
  if (repeat === 'all') return 'REPEAT_ALL';
  return 'NORMAL';
}

class Player {
  /**
   * @param {import('./topology').Topology} topology
   * @param {Object} [searchProvider] Optional provider used to repair queue metadata.
   */
  constructor(topology, searchProvider = null) {
    this.topology = topology;
    this.searchProvider = searchProvider;
  }

  // ---- Routing helpers ----

  _coordinator(room) {
    const coordinator = this.topology.coordinatorFor(room);
    if (!coordinator || !coordinator.ip) {
      throw new SonosError(`Unknown room: ${room}`, { action: 'route' });
    }
    return coordinator;
  }

  _player(room) {
    const player = this.topology.playerFor(room);
    if (!player || !player.ip) {
      throw new SonosError(`Unknown room: ${room}`, { action: 'route' });
    }
    return player;
  }

  /** The URI that means "play this coordinator's own queue". */
  _queueUri(coordinatorUuid) {
    return `x-rincon-queue:${coordinatorUuid}#0`;
  }

  // ---- Transport (coordinator-scoped) ----

  async play(room) {
    await dev.transport.play(this._coordinator(room).ip);
  }

  async pause(room) {
    await dev.transport.pause(this._coordinator(room).ip);
  }

  async stop(room) {
    await dev.transport.stop(this._coordinator(room).ip);
  }

  async next(room) {
    await dev.transport.next(this._coordinator(room).ip);
  }

  async previous(room) {
    await dev.transport.previous(this._coordinator(room).ip);
  }

  async toggle(room) {
    const ip = this._coordinator(room).ip;
    const info = await dev.transport.getTransportInfo(ip);
    if (info.state === 'PLAYING' || info.state === 'TRANSITIONING') {
      await dev.transport.pause(ip);
      return 'PAUSED_PLAYBACK';
    }
    await dev.transport.play(ip);
    return 'PLAYING';
  }

  /** Seek within the current track. @param {number} seconds */
  async seekTo(room, seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const target = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    await dev.transport.seek(this._coordinator(room).ip, 'REL_TIME', target);
  }

  /** Jump to a 1-based position in the queue. */
  async playQueueIndex(room, index) {
    const coordinator = this._coordinator(room);
    await this._ensurePlayingFromQueue(coordinator);
    await dev.transport.seek(coordinator.ip, 'TRACK_NR', index);
    await dev.transport.play(coordinator.ip);
  }

  /**
   * A coordinator only honours TRACK_NR seeks while its transport is pointed at its
   * own queue. If it is currently on a radio stream, seeking silently does nothing —
   * so we re-point it first.
   */
  async _ensurePlayingFromQueue(coordinator) {
    const media = await dev.transport.getMediaInfo(coordinator.ip);
    const wanted = this._queueUri(coordinator.uuid);
    if (media.currentUri !== wanted) {
      await dev.transport.setAVTransportURI(coordinator.ip, wanted, '');
    }
  }

  // ---- Play modes ----

  async setPlayMode(room, { shuffle, repeat }) {
    const ip = this._coordinator(room).ip;
    const current = await dev.transport.getTransportSettings(ip);
    const decoded = PLAY_MODES[current.playMode] || PLAY_MODES.NORMAL;
    const mode = toPlayMode(
      shuffle === undefined ? decoded.shuffle : !!shuffle,
      repeat === undefined ? decoded.repeat : repeat
    );
    await dev.transport.setPlayMode(ip, mode);
    return mode;
  }

  async setCrossfade(room, enabled) {
    await dev.transport.setCrossfadeMode(this._coordinator(room).ip, enabled);
  }

  // ---- Volume (player-scoped) ----

  async getVolume(room) {
    return dev.rendering.getVolume(this._player(room).ip);
  }

  async setVolume(room, volume) {
    return dev.rendering.setVolume(this._player(room).ip, volume);
  }

  async adjustVolume(room, delta) {
    return dev.rendering.setRelativeVolume(this._player(room).ip, delta);
  }

  async setMute(room, muted) {
    return dev.rendering.setMute(this._player(room).ip, muted);
  }

  // ---- Group volume (coordinator-scoped) ----

  async setGroupVolume(room, volume) {
    return dev.groupRendering.setGroupVolume(this._coordinator(room).ip, volume);
  }

  /** Proportionally scales every member — the correct way to ride a whole group. */
  async adjustGroupVolume(room, delta) {
    return dev.groupRendering.setRelativeGroupVolume(this._coordinator(room).ip, delta);
  }

  async setGroupMute(room, muted) {
    await dev.groupRendering.setGroupMute(this._coordinator(room).ip, muted);
  }

  // ---- Grouping ----

  /**
   * Make `room` join the group that `targetRoom` belongs to.
   * The joining device is pointed at the target's COORDINATOR, not the target itself —
   * joining a non-coordinator otherwise creates a split group.
   */
  async join(room, targetRoom) {
    const joining = this._player(room);
    const target = this._coordinator(targetRoom);
    if (joining.uuid === target.uuid) return { room, joined: targetRoom, noop: true };
    await dev.transport.setAVTransportURI(joining.ip, `x-rincon:${target.uuid}`, '');
    await this.topology.refresh({ settle: true });
    return { room, joined: target.name };
  }

  /** Detach a room into its own group. */
  async leave(room) {
    const player = this._player(room);
    await dev.transport.becomeCoordinatorOfStandaloneGroup(player.ip);
    await this.topology.refresh({ settle: true });
    return { room, standalone: true };
  }

  /**
   * Group every room in the household onto one coordinator.
   * Members are joined in parallel — each SetAVTransportURI is independent — but the
   * coordinator itself is left alone so playback never stops.
   */
  async party(room) {
    const coordinator = this._coordinator(room);
    const others = this.topology.rooms.filter((r) => r.uuid !== coordinator.uuid);
    const results = await Promise.allSettled(
      others.map((r) => dev.transport.setAVTransportURI(r.ip, `x-rincon:${coordinator.uuid}`, ''))
    );
    await this.topology.refresh({ settle: true });
    return {
      coordinator: coordinator.name,
      joined: results.filter((r) => r.status === 'fulfilled').length,
      failed: results
        .map((r, i) => (r.status === 'rejected' ? others[i].name : null))
        .filter(Boolean),
    };
  }

  /** Break every group apart. */
  async ungroupAll() {
    const grouped = this.topology.rooms.filter((r) => {
      const group = this.topology.groupById(r.groupId);
      return group && group.size > 1;
    });
    const results = await Promise.allSettled(
      grouped.map((r) => dev.transport.becomeCoordinatorOfStandaloneGroup(r.ip))
    );
    await this.topology.refresh({ settle: true });
    return { ungrouped: results.filter((r) => r.status === 'fulfilled').length };
  }

  /**
   * Set a group's membership to exactly `roomNames` (plus the coordinator).
   * Used by the grouping sheet, where the user toggles checkboxes and hits done.
   */
  async setGroupMembers(coordinatorRoom, roomNames) {
    const coordinator = this._coordinator(coordinatorRoom);
    const wanted = new Set(roomNames);
    wanted.delete(coordinator.name);

    const group = this.topology.groupById(this.topology.roomByName(coordinatorRoom).groupId);
    const currentMembers = group ? group.members.filter((m) => m.uuid !== coordinator.uuid) : [];

    const toRemove = currentMembers.filter((m) => !wanted.has(m.name));
    const toAdd = [...wanted]
      .map((name) => this.topology.roomByName(name))
      .filter((r) => r && !currentMembers.some((m) => m.uuid === r.uuid));

    await Promise.allSettled([
      ...toRemove.map((m) => dev.transport.becomeCoordinatorOfStandaloneGroup(m.ip)),
      ...toAdd.map((r) => dev.transport.setAVTransportURI(r.ip, `x-rincon:${coordinator.uuid}`, '')),
    ]);
    await this.topology.refresh({ settle: true });
    return { coordinator: coordinator.name, added: toAdd.length, removed: toRemove.length };
  }

  // ---- Playing content ----

  /**
   * Play any item, choosing the correct mechanism from its URI.
   * `mode` is one of 'now' | 'next' | 'queue'.
   *
   * Containers and streams replace what the group is doing; tracks are enqueued.
   * This is the decision tree that most third-party clients get wrong.
   */
  async playItem(room, item, mode = 'now') {
    const coordinator = this._coordinator(room);
    const uri = item.uri;
    if (!uri) throw new SonosError('Item has no playable URI', { action: 'playItem' });

    const info = didl.classifyUri(uri);
    const metadata = item.metadata || item.resMD || '';

    // Streams and containers can only be "played now" — there is no queue semantics
    // for a radio station, and enqueuing a container means expanding it.
    if (info.playAs === 'stream') {
      await dev.transport.setAVTransportURI(coordinator.ip, uri, metadata);
      await dev.transport.play(coordinator.ip);
      return { played: 'stream', uri };
    }

    if (info.playAs === 'container') {
      if (mode === 'now') {
        // Replace the queue with this container, then start at track 1.
        await dev.transport.removeAllTracksFromQueue(coordinator.ip);
        await dev.transport.addURIToQueue(coordinator.ip, uri, metadata, { desiredFirstTrack: 0 });
        await dev.transport.setAVTransportURI(coordinator.ip, this._queueUri(coordinator.uuid), '');
        await dev.transport.seek(coordinator.ip, 'TRACK_NR', 1);
        await dev.transport.play(coordinator.ip);
        return { played: 'container', uri, replacedQueue: true };
      }
      const result = await dev.transport.addURIToQueue(coordinator.ip, uri, metadata, {
        asNext: mode === 'next',
      });
      return { queued: 'container', uri, ...result };
    }

    // Single track.
    const result = await dev.transport.addURIToQueue(coordinator.ip, uri, metadata, {
      asNext: mode === 'now' || mode === 'next',
    });

    if (mode === 'now') {
      await this._ensurePlayingFromQueue(coordinator);
      await dev.transport.seek(coordinator.ip, 'TRACK_NR', result.firstTrackNumberEnqueued);
      await dev.transport.play(coordinator.ip);
    }
    return { queued: 'track', uri, ...result, playedNow: mode === 'now' };
  }

  /** Play another room's line-in through this room's group (turntable, TV, etc). */
  async playLineIn(room, sourceRoom) {
    const coordinator = this._coordinator(room);
    const source = this._player(sourceRoom);
    await dev.transport.setAVTransportURI(coordinator.ip, `x-rincon-stream:${source.uuid}`, '');
    await dev.transport.play(coordinator.ip);
    return { room, source: source.name };
  }

  // ---- Queue ----

  async getQueue(room, { start = 0, count = 200 } = {}) {
    const coordinator = this._coordinator(room);
    const page = await dev.content.browse(coordinator.ip, 'Q:0', { start, count });
    const tracks = didl.parseDidl(page.raw, coordinator.ip);
    await this._repairMetadata(tracks);
    return {
      tracks,
      total: page.totalMatches,
      returned: page.numberReturned,
      start,
      updateId: page.updateId,
    };
  }

  /**
   * Fill in queue entries that Sonos returned without metadata.
   *
   * Sonos sometimes serves a queue item as nothing but a res URI plus album art —
   * no title, no artist. Rendering those as blank rows looks broken, and the data is
   * not actually missing: the URI still carries the service track id. If a search
   * provider is attached we recover the real metadata from it in one batched call.
   *
   * Best-effort by design — a provider outage leaves the rows as they were rather
   * than failing the queue read.
   */
  async _repairMetadata(tracks) {
    if (!this.searchProvider || !this.searchProvider.available) return;
    const broken = tracks.filter((t) => t && !t.title && t.uri);
    if (!broken.length) return;

    const ids = broken
      .map((t) => this.searchProvider.constructor.trackIdFromUri(t.uri))
      .filter(Boolean);
    if (!ids.length) return;

    try {
      const found = await this.searchProvider.tracksByIds(ids);
      for (const track of broken) {
        const id = this.searchProvider.constructor.trackIdFromUri(track.uri);
        const meta = id && found.get(id);
        if (!meta) continue;
        track.title = meta.title;
        track.artist = meta.artist;
        track.album = meta.album;
        track.duration = track.duration || meta.duration;
        track.durationSeconds = track.durationSeconds || meta.durationSeconds;
        if (!track.art) track.art = meta.art;
        track.repaired = true;
      }
    } catch (_) {
      // Leave the rows untouched.
    }
  }

  async clearQueue(room) {
    await dev.transport.removeAllTracksFromQueue(this._coordinator(room).ip);
  }

  async removeFromQueue(room, index) {
    await dev.transport.removeTrackFromQueue(this._coordinator(room).ip, index);
  }

  /**
   * Move the track at `from` to sit at `to` (both 1-based, as displayed).
   *
   * ReorderTracksInQueue takes an InsertBefore index evaluated against the queue
   * BEFORE the move. Moving downward therefore needs `to + 1`, because the tracks
   * between shift up by one once the source is lifted out. Moving upward is a
   * straight insert. Getting this off by one is the classic drag-and-drop bug.
   */
  async reorderQueue(room, from, to) {
    if (from === to) return { from, to, noop: true };
    const insertBefore = to > from ? to + 1 : to;
    await dev.transport.reorderTracksInQueue(this._coordinator(room).ip, from, 1, insertBefore);
    return { from, to, insertBefore };
  }

  async saveQueue(room, title) {
    const objectId = await dev.transport.saveQueue(this._coordinator(room).ip, title);
    return { title, objectId };
  }

  // ---- Sleep timer ----

  async setSleepTimer(room, minutes) {
    const ip = this._coordinator(room).ip;
    if (!minutes) {
      await dev.transport.configureSleepTimer(ip, '');
      return { cancelled: true };
    }
    const total = Math.max(1, Math.min(600, Math.round(minutes)));
    const duration = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}:00`;
    await dev.transport.configureSleepTimer(ip, duration);
    return { minutes: total, duration };
  }

  async getSleepTimer(room) {
    return dev.transport.getRemainingSleepTimerDuration(this._coordinator(room).ip);
  }

  // ---- State ----

  /**
   * Everything the now-playing screen needs for one room, in a single round of
   * parallel calls. Failures degrade to nulls rather than rejecting the whole read —
   * one asleep speaker must not blank the entire household view.
   */
  async nowPlaying(room, { withQueueLength = false } = {}) {
    const roomRecord = this.topology.roomByName(room);
    if (!roomRecord) return null;
    const group = this.topology.groupById(roomRecord.groupId);
    const coordinatorIp = group ? group.coordinatorIp : roomRecord.ip;
    const isCoordinator = roomRecord.isCoordinator;

    const [transportInfo, position, media, settings, volume, mute, actions] = await Promise.all([
      dev.transport.getTransportInfo(coordinatorIp).catch(() => null),
      dev.transport.getPositionInfo(coordinatorIp).catch(() => null),
      dev.transport.getMediaInfo(coordinatorIp).catch(() => null),
      dev.transport.getTransportSettings(coordinatorIp).catch(() => null),
      dev.rendering.getVolume(roomRecord.ip).catch(() => null),
      dev.rendering.getMute(roomRecord.ip).catch(() => null),
      dev.transport.getCurrentTransportActions(coordinatorIp).catch(() => []),
    ]);

    const track = position && position.metadataRaw
      ? didl.parseDidlOne(position.metadataRaw, coordinatorIp)
      : null;

    // Sonos often omits dc:title/dc:creator from the current track's metadata.
    // The URI still identifies it, so recover the real details the same way the
    // queue does rather than rendering a nameless player.
    if (track && !track.title) await this._repairMetadata([track]);

    // The number of tracks in the SAVED queue is not NrTracks. NrTracks describes
    // whatever is loaded right now — it is 1 when the transport points at a single
    // track, even though the room's queue may still hold a hundred. The UI needs the
    // queue's own size, so fetch it when rendering a detail screen.
    let savedQueueLength = null;
    if (withQueueLength) {
      const page = await dev.content
        .browse(coordinatorIp, 'Q:0', { start: 0, count: 1 })
        .catch(() => null);
      savedQueueLength = page ? page.totalMatches : null;
    }

    // For radio, the station name lives in the enclosing media metadata while the
    // track title carries the current song via r:streamContent.
    const enclosing = media && media.currentUriMetadataRaw
      ? didl.parseDidlOne(media.currentUriMetadataRaw, coordinatorIp)
      : null;

    const source = didl.classifyUri(media ? media.currentUri : null);
    const playMode = PLAY_MODES[settings ? settings.playMode : 'NORMAL'] || PLAY_MODES.NORMAL;

    return {
      room: roomRecord.name,
      uuid: roomRecord.uuid,
      ip: roomRecord.ip,
      model: roomRecord.model || null,
      offline: !transportInfo && volume === null,

      groupId: roomRecord.groupId,
      groupName: group ? group.name : roomRecord.name,
      groupSize: group ? group.size : 1,
      isCoordinator,
      coordinatorName: group ? group.coordinatorName : roomRecord.name,
      groupMembers: group ? group.members.map((m) => m.name) : [roomRecord.name],

      state: transportInfo ? transportInfo.state : 'UNKNOWN',
      volume,
      muted: mute,

      shuffle: playMode.shuffle,
      repeat: playMode.repeat,

      sourceKind: source.kind,
      service: track ? track.service || source.service : source.service,

      track: track
        ? {
            title: track.streamContent || track.title,
            // On radio, streamContent holds "Artist - Title" and dc:title the station.
            artist: track.artist,
            album: track.album,
            art: track.art,
            duration: position ? position.duration : null,
            durationSeconds: didl.durationToSeconds(position ? position.duration : null),
            uri: track.uri,
            station: enclosing ? enclosing.title : null,
          }
        : null,

      position: position ? position.relTime : null,
      positionSeconds: didl.durationToSeconds(position ? position.relTime : null),
      queueTrack: position ? position.track : 0,
      // Tracks in whatever is currently loaded (1 for a single track or a stream).
      mediaTracks: media ? media.nrTracks : 0,
      // Tracks in the room's saved queue; null when not requested.
      queueLength: savedQueueLength,
      // True when the transport is actually pointed at the queue rather than at a
      // standalone track or stream — the only case where Next/Previous walk a list.
      playingFromQueue: source.kind === 'queue',

      canNext: actions.includes('Next'),
      canPrevious: actions.includes('Previous'),
      canSeek: actions.some((a) => a.includes('Seek')),
      canPause: actions.includes('Pause'),
    };
  }

  /** nowPlaying for every room, in parallel. */
  async snapshot() {
    const results = await Promise.all(
      this.topology.rooms.map((r) =>
        this.nowPlaying(r.name).catch((e) => ({
          room: r.name,
          uuid: r.uuid,
          ip: r.ip,
          offline: true,
          error: e.message,
          state: 'UNKNOWN',
        }))
      )
    );
    return results.filter(Boolean);
  }
}

module.exports = { Player, PLAY_MODES, toPlayMode };
