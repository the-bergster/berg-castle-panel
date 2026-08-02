// sonos/intercom-bridge.js
//
// Thin adapter that gives the Intercom feature what it needs from the new
// modular Sonos subsystem: resolve a room name to a player IP, capture its
// full pre-broadcast state, fire the broadcast, and later restore state.
//
// Kept out of player.js because the Intercom needs "raw" per-player transport
// commands (each target zone becomes independent for the duration of the
// broadcast, then rejoins its previous group if it had one). The rest of
// player.js is group-coordinator-aware routing; the intercom deliberately
// bypasses that model for the duration of a message.
//
// The capture/restore behaviour matches what shipped on the intercom feature
// branch before the parity merge, but sourced against sonos/device.js rather
// than the retired flat sonos.js.

'use strict';

const dev = require('./device');
const X = require('./xml');

function decodePickTextEntities(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

class IntercomBridge {
  constructor(topology) {
    this.topology = topology;
  }

  /** Resolve a room name to its individual player record ({ ip, uuid, name, ... }). */
  playerFor(room) {
    const record = this.topology.roomByName(room);
    if (!record || !record.ip) return null;
    return record;
  }

  /**
   * Capture full state for later restore. Grabs URI, raw metadata, transport state,
   * volume, playback position, track number, and a flag for queue-mode playback.
   */
  async captureState(ip) {
    const [tiRes, piRes, miRes, volRes] = await Promise.all([
      dev.transport.getTransportInfo(ip).catch(() => null),
      dev.transport.getPositionInfo(ip).catch(() => null),
      dev.transport.getMediaInfo(ip).catch(() => null),
      dev.rendering.getVolume(ip).catch(() => null),
    ]);

    const state = tiRes?.state || 'STOPPED';
    const trackUri = decodePickTextEntities(piRes?.uri || '');
    const trackMeta = decodePickTextEntities(piRes?.metadataRaw || '');
    const relTime = piRes?.relTime || '0:00:00';
    const trackNum = typeof piRes?.track === 'number' ? piRes.track : 0;
    const currentUri = decodePickTextEntities(miRes?.currentUri || trackUri);
    const currentUriMeta = decodePickTextEntities(miRes?.currentUriMetadataRaw || '');
    const isQueue = /^x-rincon-queue:/i.test(currentUri);

    return {
      ip,
      state,
      volume: typeof volRes === 'number' ? volRes : 0,
      current_uri: currentUri,
      current_uri_metadata: currentUriMeta,
      track_uri: trackUri,
      track_metadata: trackMeta,
      position: relTime,
      track_number: trackNum,
      is_queue: isQueue,
      captured_at: Date.now(),
    };
  }

  /**
   * Play the intercom recording immediately on one player.
   * Bypasses group coordination — the target zone becomes independent for the
   * duration of the message. Restore will put it back in its previous group.
   */
  async playAnnouncement(ip, url, volume) {
    if (typeof volume === 'number') {
      await dev.rendering.setVolume(ip, volume).catch(() => {});
    }
    await dev.transport.setAVTransportURI(ip, url, '');
    await dev.transport.play(ip);
  }

  /**
   * Best-effort restore of a captured state. Individual step failures are logged
   * to the returned notes but don't abort the rest of the sequence.
   */
  async restoreState(state) {
    const { ip } = state;
    const restoreUri = state.current_uri || state.track_uri;
    const restoreMeta = state.current_uri_metadata || state.track_metadata || '';
    const notes = [];

    if (!restoreUri) {
      await dev.transport.stop(ip).catch(() => {});
      if (typeof state.volume === 'number') await dev.rendering.setVolume(ip, state.volume).catch(() => {});
      return { ip, restored: true, note: 'no prior URI, left stopped' };
    }

    try {
      await dev.transport.setAVTransportURI(ip, restoreUri, restoreMeta);
    } catch (e) {
      return { ip, restored: false, error: `SetAVTransportURI failed: ${e.message}` };
    }

    // Queue-based playback: jump to the correct track first.
    if (state.is_queue && state.track_number > 0) {
      try {
        await dev.transport.seek(ip, 'TRACK_NR', state.track_number);
        notes.push(`seeked to track ${state.track_number}`);
      } catch (e) {
        notes.push(`track seek failed: ${e.message}`);
      }
    }

    // Seek to the playback position within the current track.
    if (state.position && state.position !== '0:00:00' && state.position !== 'NOT_IMPLEMENTED') {
      await dev.transport.seek(ip, 'REL_TIME', state.position).catch((e) => notes.push(`REL_TIME seek failed: ${e.message}`));
    }

    if (typeof state.volume === 'number') {
      await dev.rendering.setVolume(ip, state.volume).catch(() => {});
    }

    if (state.state === 'PLAYING' || state.state === 'TRANSITIONING') {
      try {
        await dev.transport.play(ip);
        notes.push('play issued');
      } catch (e) {
        notes.push(`play failed: ${e.message}`);
      }
    }

    return { ip, restored: true, is_queue: state.is_queue, notes };
  }
}

module.exports = { IntercomBridge };
