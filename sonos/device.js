// sonos/device.js — Typed wrappers over every Sonos UPnP service action we use.
//
// Everything here takes a device IP as its first argument and is otherwise stateless.
// Routing (which IP a given command belongs to) is decided a layer up in player.js,
// because that decision depends on live group topology.
//
// The one rule worth internalising:
//   * TRANSPORT and QUEUE actions belong to the GROUP COORDINATOR.
//   * RENDERING actions (volume, mute, bass, treble, EQ) belong to the INDIVIDUAL PLAYER.
//   * GROUP RENDERING actions belong to the GROUP COORDINATOR.
// Sending a transport command to a grouped non-coordinator returns UPnP 1023.

'use strict';

const X = require('./xml');
const { request, tryRequest, SonosError } = require('./soap');

const INSTANCE = { InstanceID: 0 };

// ---------------------------------------------------------------------------
// AVTransport — playback, queue mutation, grouping, sleep timer
// ---------------------------------------------------------------------------

const transport = {
  async play(ip, speed = 1) {
    await request(ip, 'AVTransport', 'Play', { InstanceID: 0, Speed: speed });
  },

  async pause(ip) {
    await request(ip, 'AVTransport', 'Pause', INSTANCE);
  },

  async stop(ip) {
    await request(ip, 'AVTransport', 'Stop', INSTANCE);
  },

  /**
   * Next/Previous are invalid on most radio streams. We surface the refusal rather
   * than swallowing it, so the UI can grey out the button instead of lying.
   */
  async next(ip) {
    await request(ip, 'AVTransport', 'Next', INSTANCE);
  },

  async previous(ip) {
    await request(ip, 'AVTransport', 'Previous', INSTANCE);
  },

  /**
   * @param {'TRACK_NR'|'REL_TIME'|'TIME_DELTA'} unit
   * @param {string|number} target  Track number, or "h:mm:ss" for REL_TIME
   */
  async seek(ip, unit, target) {
    await request(ip, 'AVTransport', 'Seek', { InstanceID: 0, Unit: unit, Target: target });
  },

  async getTransportInfo(ip) {
    const res = await request(ip, 'AVTransport', 'GetTransportInfo', INSTANCE);
    return {
      state: X.text(res, 'CurrentTransportState'), // PLAYING|PAUSED_PLAYBACK|STOPPED|TRANSITIONING
      status: X.text(res, 'CurrentTransportStatus'),
      speed: X.text(res, 'CurrentSpeed'),
    };
  },

  async getPositionInfo(ip) {
    const res = await request(ip, 'AVTransport', 'GetPositionInfo', INSTANCE);
    return {
      track: X.int(res, 'Track', 0),
      duration: X.text(res, 'TrackDuration'),
      metadataRaw: X.text(res, 'TrackMetaData'),
      uri: X.text(res, 'TrackURI'),
      relTime: X.text(res, 'RelTime'),
      absTime: X.text(res, 'AbsTime'),
    };
  },

  /**
   * GetMediaInfo carries what is *loaded*, as opposed to what is *playing*.
   * CurrentURI is the discriminator between queue playback and a direct stream:
   * playing the queue yields "x-rincon-queue:RINCON_xxx#0"; a radio station yields
   * the station URI itself; a grouped member yields "x-rincon:<coordinator-uuid>".
   */
  async getMediaInfo(ip) {
    const res = await request(ip, 'AVTransport', 'GetMediaInfo', INSTANCE);
    return {
      nrTracks: X.int(res, 'NrTracks', 0),
      mediaDuration: X.text(res, 'MediaDuration'),
      currentUri: X.text(res, 'CurrentURI'),
      currentUriMetadataRaw: X.text(res, 'CurrentURIMetaData'),
      nextUri: X.text(res, 'NextURI'),
      playMedium: X.text(res, 'PlayMedium'),
    };
  },

  async getTransportSettings(ip) {
    const res = await request(ip, 'AVTransport', 'GetTransportSettings', INSTANCE);
    return {
      playMode: X.text(res, 'PlayMode'), // NORMAL|REPEAT_ALL|REPEAT_ONE|SHUFFLE|SHUFFLE_NOREPEAT|SHUFFLE_REPEAT_ONE
      recQualityMode: X.text(res, 'RecQualityMode'),
    };
  },

  async setPlayMode(ip, playMode) {
    await request(ip, 'AVTransport', 'SetPlayMode', { InstanceID: 0, NewPlayMode: playMode });
  },

  async getCrossfadeMode(ip) {
    const res = await tryRequest(ip, 'AVTransport', 'GetCrossfadeMode', INSTANCE, null);
    return res ? X.text(res, 'CrossfadeMode') === '1' : false;
  },

  async setCrossfadeMode(ip, enabled) {
    await request(ip, 'AVTransport', 'SetCrossfadeMode', {
      InstanceID: 0,
      CrossfadeMode: enabled ? 1 : 0,
    });
  },

  /**
   * Which transport buttons should be live. Returns e.g. "Play,Stop,Pause,Next,Previous,X_DLNA_SeekTime".
   * Radio streams omit Next/Previous, which is exactly how the UI knows to disable them.
   */
  async getCurrentTransportActions(ip) {
    const res = await tryRequest(ip, 'AVTransport', 'GetCurrentTransportActions', INSTANCE, null);
    const raw = res ? X.text(res, 'Actions', '') : '';
    return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  },

  async setAVTransportURI(ip, uri, metadata = '') {
    await request(ip, 'AVTransport', 'SetAVTransportURI', {
      InstanceID: 0,
      CurrentURI: uri,
      CurrentURIMetaData: metadata,
    });
  },

  async setNextAVTransportURI(ip, uri, metadata = '') {
    await request(ip, 'AVTransport', 'SetNextAVTransportURI', {
      InstanceID: 0,
      NextURI: uri,
      NextURIMetaData: metadata,
    });
  },

  // ---- Queue mutation (coordinator only) ----

  /**
   * @param {boolean} asNext  true = "play next" (insert after current track)
   * @param {number} desiredFirstTrack 0 = append to end
   */
  async addURIToQueue(ip, uri, metadata = '', { asNext = false, desiredFirstTrack = 0 } = {}) {
    const res = await request(ip, 'AVTransport', 'AddURIToQueue', {
      InstanceID: 0,
      EnqueuedURI: uri,
      EnqueuedURIMetaData: metadata,
      DesiredFirstTrackNumberEnqueued: desiredFirstTrack,
      EnqueueAsNext: asNext ? 1 : 0,
    });
    return {
      firstTrackNumberEnqueued: X.int(res, 'FirstTrackNumberEnqueued', 0),
      numTracksAdded: X.int(res, 'NumTracksAdded', 0),
      newQueueLength: X.int(res, 'NewQueueLength', 0),
    };
  },

  /** Add a whole container (album, playlist) in one call. */
  async addMultipleURIsToQueue(ip, containerUri, containerMetadata, { asNext = false, desiredFirstTrack = 0 } = {}) {
    const res = await request(ip, 'AVTransport', 'AddMultipleURIsToQueue', {
      InstanceID: 0,
      UpdateID: 0,
      NumberOfURIs: 1,
      EnqueuedURIs: containerUri,
      EnqueuedURIsMetaData: containerMetadata,
      ContainerURI: containerUri,
      ContainerMetaData: containerMetadata,
      DesiredFirstTrackNumberEnqueued: desiredFirstTrack,
      EnqueueAsNext: asNext ? 1 : 0,
    });
    return {
      firstTrackNumberEnqueued: X.int(res, 'FirstTrackNumberEnqueued', 0),
      numTracksAdded: X.int(res, 'NumTracksAdded', 0),
      newQueueLength: X.int(res, 'NewQueueLength', 0),
    };
  },

  /** @param {number} index 1-based queue position */
  async removeTrackFromQueue(ip, index, updateId = 0) {
    await request(ip, 'AVTransport', 'RemoveTrackFromQueue', {
      InstanceID: 0,
      ObjectID: `Q:0/${index}`,
      UpdateID: updateId,
    });
  },

  async removeTrackRangeFromQueue(ip, startIndex, count, updateId = 0) {
    const res = await request(ip, 'AVTransport', 'RemoveTrackRangeFromQueue', {
      InstanceID: 0,
      UpdateID: updateId,
      StartingIndex: startIndex,
      NumberOfTracks: count,
    });
    return X.int(res, 'NewUpdateID', 0);
  },

  async removeAllTracksFromQueue(ip) {
    await request(ip, 'AVTransport', 'RemoveAllTracksFromQueue', INSTANCE);
  },

  /**
   * Move `count` tracks starting at `startIndex` so they sit before `insertBefore`.
   * All indices are 1-based and evaluated against the queue as it exists BEFORE the
   * move — which is why moving a track downward needs insertBefore to account for
   * the tracks that shift up. reorderQueue() in player.js wraps this with sane
   * "move item from A to B" semantics.
   */
  async reorderTracksInQueue(ip, startIndex, count, insertBefore, updateId = 0) {
    await request(ip, 'AVTransport', 'ReorderTracksInQueue', {
      InstanceID: 0,
      StartingIndex: startIndex,
      NumberOfTracks: count,
      InsertBefore: insertBefore,
      UpdateID: updateId,
    });
  },

  /** Save the current queue as a Sonos playlist. Returns the new SQ: object id. */
  async saveQueue(ip, title, objectId = '') {
    const res = await request(ip, 'AVTransport', 'SaveQueue', {
      InstanceID: 0,
      Title: title,
      ObjectID: objectId,
    });
    return X.text(res, 'AssignedObjectID');
  },

  // ---- Grouping ----

  /** Detach this player into its own group. */
  async becomeCoordinatorOfStandaloneGroup(ip) {
    await request(ip, 'AVTransport', 'BecomeCoordinatorOfStandaloneGroup', INSTANCE);
  },

  /** Sleep timer. Pass null/'' to cancel. Format is "HH:MM:SS". */
  async configureSleepTimer(ip, duration) {
    await request(ip, 'AVTransport', 'ConfigureSleepTimer', {
      InstanceID: 0,
      NewSleepTimerDuration: duration || '',
    });
  },

  async getRemainingSleepTimerDuration(ip) {
    const res = await tryRequest(ip, 'AVTransport', 'GetRemainingSleepTimerDuration', INSTANCE, null);
    if (!res) return null;
    const remaining = X.text(res, 'RemainingSleepTimerDuration', '');
    return remaining || null;
  },
};

// ---------------------------------------------------------------------------
// RenderingControl — per-player volume, mute, tone, EQ
// ---------------------------------------------------------------------------

const rendering = {
  async getVolume(ip, channel = 'Master') {
    const res = await request(ip, 'RenderingControl', 'GetVolume', { InstanceID: 0, Channel: channel });
    return X.int(res, 'CurrentVolume', 0);
  },

  async setVolume(ip, volume, channel = 'Master') {
    const clamped = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)));
    await request(ip, 'RenderingControl', 'SetVolume', {
      InstanceID: 0,
      Channel: channel,
      DesiredVolume: clamped,
    });
    return clamped;
  },

  /** Relative nudge; the device clamps and returns the resulting absolute volume. */
  async setRelativeVolume(ip, adjustment, channel = 'Master') {
    const res = await request(ip, 'RenderingControl', 'SetRelativeVolume', {
      InstanceID: 0,
      Channel: channel,
      Adjustment: Math.round(Number(adjustment) || 0),
    });
    return X.int(res, 'NewVolume', 0);
  },

  async getMute(ip, channel = 'Master') {
    const res = await request(ip, 'RenderingControl', 'GetMute', { InstanceID: 0, Channel: channel });
    return X.text(res, 'CurrentMute') === '1';
  },

  async setMute(ip, muted, channel = 'Master') {
    await request(ip, 'RenderingControl', 'SetMute', {
      InstanceID: 0,
      Channel: channel,
      DesiredMute: muted ? 1 : 0,
    });
    return !!muted;
  },

  async getBass(ip) {
    const res = await tryRequest(ip, 'RenderingControl', 'GetBass', INSTANCE, null);
    return res ? X.int(res, 'CurrentBass', 0) : null;
  },

  async setBass(ip, value) {
    await request(ip, 'RenderingControl', 'SetBass', {
      InstanceID: 0,
      DesiredBass: Math.max(-10, Math.min(10, Math.round(value))),
    });
  },

  async getTreble(ip) {
    const res = await tryRequest(ip, 'RenderingControl', 'GetTreble', INSTANCE, null);
    return res ? X.int(res, 'CurrentTreble', 0) : null;
  },

  async setTreble(ip, value) {
    await request(ip, 'RenderingControl', 'SetTreble', {
      InstanceID: 0,
      DesiredTreble: Math.max(-10, Math.min(10, Math.round(value))),
    });
  },

  async getLoudness(ip, channel = 'Master') {
    const res = await tryRequest(ip, 'RenderingControl', 'GetLoudness', { InstanceID: 0, Channel: channel }, null);
    return res ? X.text(res, 'CurrentLoudness') === '1' : null;
  },

  async setLoudness(ip, enabled, channel = 'Master') {
    await request(ip, 'RenderingControl', 'SetLoudness', {
      InstanceID: 0,
      Channel: channel,
      DesiredLoudness: enabled ? 1 : 0,
    });
  },

  /**
   * Extended EQ. Which EQTypes a device accepts is model-dependent — an Arc supports
   * NightMode and DialogLevel, a Play:3 supports neither and answers UPnP 402.
   * Returns null for unsupported types, which is how capability detection works.
   */
  async getEQ(ip, eqType) {
    const res = await tryRequest(ip, 'RenderingControl', 'GetEQ', { InstanceID: 0, EQType: eqType }, null);
    return res ? X.int(res, 'CurrentValue', 0) : null;
  },

  async setEQ(ip, eqType, value) {
    await request(ip, 'RenderingControl', 'SetEQ', {
      InstanceID: 0,
      EQType: eqType,
      DesiredValue: value,
    });
  },

  /**
   * An Amp wired into a third-party amplifier can be set to fixed line-level output.
   * When true the volume slider must be hidden — sending SetVolume is a no-op and
   * showing a dead slider is the kind of detail that makes an app feel fake.
   */
  async getOutputFixed(ip) {
    const res = await tryRequest(ip, 'RenderingControl', 'GetOutputFixed', INSTANCE, null);
    return res ? X.text(res, 'CurrentFixed') === '1' : null;
  },

  async getSupportsOutputFixed(ip) {
    const res = await tryRequest(ip, 'RenderingControl', 'GetSupportsOutputFixed', INSTANCE, null);
    return res ? X.text(res, 'CurrentSupportsFixed') === '1' : null;
  },
};

// ---------------------------------------------------------------------------
// GroupRenderingControl — coordinator-scoped volume for the whole group
// ---------------------------------------------------------------------------

const groupRendering = {
  async getGroupVolume(ip) {
    const res = await request(ip, 'GroupRenderingControl', 'GetGroupVolume', INSTANCE);
    return X.int(res, 'CurrentVolume', 0);
  },

  async setGroupVolume(ip, volume) {
    const clamped = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)));
    await request(ip, 'GroupRenderingControl', 'SetGroupVolume', {
      InstanceID: 0,
      DesiredVolume: clamped,
    });
    return clamped;
  },

  /** Scales every member proportionally — the correct way to ride a group's level. */
  async setRelativeGroupVolume(ip, adjustment) {
    const res = await request(ip, 'GroupRenderingControl', 'SetRelativeGroupVolume', {
      InstanceID: 0,
      Adjustment: Math.round(Number(adjustment) || 0),
    });
    return X.int(res, 'NewVolume', 0);
  },

  async getGroupMute(ip) {
    const res = await request(ip, 'GroupRenderingControl', 'GetGroupMute', INSTANCE);
    return X.text(res, 'CurrentMute') === '1';
  },

  async setGroupMute(ip, muted) {
    await request(ip, 'GroupRenderingControl', 'SetGroupMute', {
      InstanceID: 0,
      DesiredMute: muted ? 1 : 0,
    });
  },
};

// ---------------------------------------------------------------------------
// ContentDirectory — favourites, playlists, queue, library
// ---------------------------------------------------------------------------

const content = {
  /**
   * @param {string} objectId  FV:2 favourites · SQ: playlists · Q:0 queue · A:* library
   * @returns {{ raw:string, numberReturned:number, totalMatches:number, updateId:number }}
   */
  async browse(ip, objectId, { start = 0, count = 100, flag = 'BrowseDirectChildren', filter = '*', sort = '' } = {}) {
    const res = await request(ip, 'ContentDirectory', 'Browse', {
      ObjectID: objectId,
      BrowseFlag: flag,
      Filter: filter,
      StartingIndex: start,
      RequestedCount: count,
      SortCriteria: sort,
    });
    return {
      raw: X.text(res, 'Result', '') || '',
      numberReturned: X.int(res, 'NumberReturned', 0),
      totalMatches: X.int(res, 'TotalMatches', 0),
      updateId: X.int(res, 'UpdateID', 0),
    };
  },

  /** Page through a container until everything is collected. */
  async browseAll(ip, objectId, { pageSize = 100, max = 2000, ...rest } = {}) {
    const pages = [];
    let start = 0;
    let total = Infinity;
    while (start < total && start < max) {
      const page = await content.browse(ip, objectId, { start, count: pageSize, ...rest });
      pages.push(page.raw);
      total = page.totalMatches || 0;
      if (!page.numberReturned) break;
      start += page.numberReturned;
    }
    return { pages, total: total === Infinity ? 0 : total };
  },

  async destroyObject(ip, objectId) {
    await request(ip, 'ContentDirectory', 'DestroyObject', { ObjectID: objectId });
  },
};

// ---------------------------------------------------------------------------
// DeviceProperties / AlarmClock / AudioIn
// ---------------------------------------------------------------------------

const props = {
  async getZoneAttributes(ip) {
    const res = await request(ip, 'DeviceProperties', 'GetZoneAttributes', {});
    return {
      name: X.text(res, 'CurrentZoneName'),
      icon: X.text(res, 'CurrentIcon'),
      configuration: X.text(res, 'CurrentConfiguration'),
    };
  },

  async getZoneInfo(ip) {
    const res = await request(ip, 'DeviceProperties', 'GetZoneInfo', {});
    return {
      serialNumber: X.text(res, 'SerialNumber'),
      softwareVersion: X.text(res, 'SoftwareVersion'),
      hardwareVersion: X.text(res, 'HardwareVersion'),
      ipAddress: X.text(res, 'IPAddress'),
      macAddress: X.text(res, 'MACAddress'),
    };
  },

  async getHouseholdId(ip) {
    const res = await tryRequest(ip, 'DeviceProperties', 'GetHouseholdID', {}, null);
    return res ? X.text(res, 'CurrentHouseholdID') : null;
  },
};

const alarms = {
  async list(ip) {
    const res = await tryRequest(ip, 'AlarmClock', 'ListAlarms', {}, null);
    if (!res) return { alarms: [], updateId: null };
    const raw = X.text(res, 'CurrentAlarmList', '') || '';
    const doc = X.parseXml(raw);
    return {
      updateId: X.text(res, 'CurrentAlarmListVersion'),
      alarms: X.findAll(doc, 'Alarm').map((a) => ({
        id: X.attr(a, 'ID'),
        startTime: X.attr(a, 'StartTime'),
        duration: X.attr(a, 'Duration'),
        recurrence: X.attr(a, 'Recurrence'),
        enabled: X.attr(a, 'Enabled') === '1',
        roomUuid: X.attr(a, 'RoomUUID'),
        programUri: X.attr(a, 'ProgramURI'),
        programMetadata: X.attr(a, 'ProgramMetaData'),
        playMode: X.attr(a, 'PlayMode'),
        volume: parseInt(X.attr(a, 'Volume', '0'), 10),
        includeLinkedZones: X.attr(a, 'IncludeLinkedZones') === '1',
      })),
    };
  },

  /** Toggle an alarm without disturbing its other settings. */
  async setEnabled(ip, alarm, enabled) {
    await request(ip, 'AlarmClock', 'UpdateAlarm', {
      ID: alarm.id,
      StartLocalTime: alarm.startTime,
      Duration: alarm.duration,
      Recurrence: alarm.recurrence,
      Enabled: enabled ? 1 : 0,
      RoomUUID: alarm.roomUuid,
      ProgramURI: alarm.programUri,
      ProgramMetaData: alarm.programMetadata,
      PlayMode: alarm.playMode,
      Volume: alarm.volume,
      IncludeLinkedZones: alarm.includeLinkedZones ? 1 : 0,
    });
  },
};

const audioIn = {
  async getLineInLevel(ip) {
    const res = await tryRequest(ip, 'AudioIn', 'GetLineInLevel', {}, null);
    if (!res) return null;
    return {
      left: X.int(res, 'CurrentLeftLineInLevel', 0),
      right: X.int(res, 'CurrentRightLineInLevel', 0),
    };
  },

  async getAudioInputAttributes(ip) {
    const res = await tryRequest(ip, 'AudioIn', 'GetAudioInputAttributes', {}, null);
    if (!res) return null;
    return { name: X.text(res, 'CurrentName'), icon: X.text(res, 'CurrentIcon') };
  },
};

module.exports = {
  transport,
  rendering,
  groupRendering,
  content,
  props,
  alarms,
  audioIn,
  SonosError,
};
