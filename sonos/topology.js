// sonos/topology.js — Live zone/group topology derived from ZoneGroupState.
//
// This replaces the old IP-sweep approach (sonos-rooms.json). The sweep was wrong in
// ways that matter:
//   * It invented a phantom room called "Sub" — the Master TV's bonded subwoofer
//     answers device_description.xml on its own IP, so a sweep sees it as a room.
//   * It gave Lounge and Master TV two "coordinators" each, because bonded surround
//     satellites also answer on their own IPs.
//   * It could never know which rooms are currently GROUPED, which determines where
//     every transport command must be sent.
//
// ZoneGroupState is the household's own answer to all three questions, and any speaker
// will report the whole household. Bonded devices appear as <Satellite Invisible="1">
// nested inside their parent <ZoneGroupMember>, so they fall out naturally.
//
// Verified against firmware 96.0-78270.

'use strict';

const { EventEmitter } = require('events');
const X = require('./xml');
const soap = require('./soap');

const STALE_MS = 30000; // full refresh cadence when nothing pushes an update
const SETTLE_MS = 600; // grouping changes need a beat before topology reads true

/** Pull the IP out of a member's Location URL. */
function ipFromLocation(location) {
  const m = /^https?:\/\/([0-9a-fA-F.:]+):\d+/.exec(location || '');
  return m ? m[1] : null;
}

/**
 * A member is a real, user-facing room when it is visible and not infrastructure.
 * Bonded satellites carry Invisible="1"; Boost/Bridge units carry IsZoneBridge="1".
 */
function isVisibleRoom(node) {
  return X.attr(node, 'Invisible', '0') !== '1' && X.attr(node, 'IsZoneBridge', '0') !== '1';
}

/** Parse one <ZoneGroupMember> / <Satellite> element into a device record. */
function parseMember(node) {
  const location = X.attr(node, 'Location');
  return {
    uuid: X.attr(node, 'UUID'),
    name: X.attr(node, 'ZoneName'),
    ip: ipFromLocation(location),
    location,
    invisible: X.attr(node, 'Invisible', '0') === '1',
    isBridge: X.attr(node, 'IsZoneBridge', '0') === '1',
    // Set on stereo pairs (ChannelMapSet) and home-theatre bonds (HTSatChanMapSet).
    channelMapSet: X.attr(node, 'ChannelMapSet', '') || X.attr(node, 'HTSatChanMapSet', ''),
    softwareVersion: X.attr(node, 'SoftwareVersion'),
    airPlay: X.attr(node, 'AirPlayEnabled', '0') === '1',
    hdmiCec: X.attr(node, 'HdmiCecAvailable', '0') === '1',
    micEnabled: X.attr(node, 'MicEnabled', '0') === '1',
    bootSeq: X.attr(node, 'BootSeq'),
  };
}

/**
 * Describe a bonded arrangement from a ChannelMapSet.
 * "RINCON_x:LF,RF;RINCON_y:LR,RR;RINCON_z:SW" → { stereoPair, surrounds, sub }
 */
function describeBonding(channelMapSet) {
  if (!channelMapSet) return { stereoPair: false, surrounds: 0, sub: false, channels: [] };
  const channels = channelMapSet
    .split(';')
    .map((part) => part.split(':')[1] || '')
    .filter(Boolean);
  const flat = channels.join(',').split(',').map((c) => c.trim()).filter(Boolean);
  return {
    stereoPair: flat.includes('LF') && flat.includes('RF') && channels.length === 2 && !flat.includes('SW'),
    surrounds: flat.filter((c) => c === 'LR' || c === 'RR').length,
    sub: flat.includes('SW'),
    channels: flat,
  };
}

class Topology extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string[]} opts.seedIps Any reachable speaker bootstraps the whole household.
   */
  constructor({ seedIps = [] } = {}) {
    super();
    this.seedIps = seedIps.slice();
    this.groups = [];
    this.rooms = [];
    this.devices = new Map(); // uuid -> device record (includes invisible satellites)
    this.updatedAt = 0;
    this.lastError = null;
    this._refreshing = null;
    this._modelCache = new Map(); // uuid -> { model, modelName, serial, ... }
  }

  /** Every IP we know about, seeds first — used to find a speaker that answers. */
  get candidateIps() {
    const live = this.rooms.map((r) => r.ip).filter(Boolean);
    return [...new Set([...live, ...this.seedIps])];
  }

  /**
   * Re-read ZoneGroupState. Concurrent callers share one in-flight request, so a
   * burst of topology events costs a single round trip.
   */
  async refresh({ settle = false } = {}) {
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      if (settle) await new Promise((r) => setTimeout(r, SETTLE_MS));
      try {
        const xml = await this._fetchZoneGroupState();
        this._apply(xml);
        this.lastError = null;
      } catch (e) {
        this.lastError = e;
        throw e;
      } finally {
        this._refreshing = null;
      }
      return this;
    })();
    return this._refreshing;
  }

  /** Refresh only if the cached view has gone stale. */
  async ensureFresh(maxAgeMs = STALE_MS) {
    if (Date.now() - this.updatedAt < maxAgeMs && this.rooms.length) return this;
    return this.refresh();
  }

  async _fetchZoneGroupState() {
    const errors = [];
    for (const ip of this.candidateIps) {
      try {
        const res = await soap.request(ip, 'ZoneGroupTopology', 'GetZoneGroupState', {}, {
          timeout: 4000,
          retries: 0,
        });
        const raw = X.text(res, 'ZoneGroupState');
        if (raw) return raw;
      } catch (e) {
        errors.push(`${ip}: ${e.message}`);
      }
    }
    throw new Error(`No Sonos speaker answered GetZoneGroupState. Tried: ${errors.join(' | ') || 'no candidates'}`);
  }

  /** Parse ZoneGroupState XML into the group/room model and emit a change event. */
  _apply(zoneGroupStateXml) {
    const doc = X.parseXml(zoneGroupStateXml);
    const groupNodes = X.findAll(doc, 'ZoneGroup');

    const groups = [];
    const rooms = [];
    const devices = new Map();

    for (const gNode of groupNodes) {
      const coordinatorUuid = X.attr(gNode, 'Coordinator');
      const groupId = X.attr(gNode, 'ID');
      const memberNodes = X.children(gNode, 'ZoneGroupMember');

      const members = [];
      for (const mNode of memberNodes) {
        const device = parseMember(mNode);
        if (!device.uuid) continue;
        devices.set(device.uuid, device);

        // Bonded satellites: recorded as devices, never surfaced as rooms.
        const satellites = X.children(mNode, 'Satellite').map(parseMember);
        for (const sat of satellites) {
          if (sat.uuid) devices.set(sat.uuid, { ...sat, bondedTo: device.uuid });
        }

        if (!isVisibleRoom(mNode)) continue;

        const bonding = describeBonding(device.channelMapSet);
        const room = {
          uuid: device.uuid,
          name: device.name,
          ip: device.ip,
          groupId,
          coordinatorUuid,
          isCoordinator: device.uuid === coordinatorUuid,
          bonded: satellites.map((s) => ({ uuid: s.uuid, ip: s.ip, name: s.name })),
          bonding,
          airPlay: device.airPlay,
          hdmiCec: device.hdmiCec,
          micEnabled: device.micEnabled,
          softwareVersion: device.softwareVersion,
        };
        members.push(room);
        rooms.push(room);
      }

      if (!members.length) continue;

      const coordinator = members.find((m) => m.isCoordinator) || members[0];
      groups.push({
        id: groupId,
        coordinatorUuid: coordinator.uuid,
        coordinatorIp: coordinator.ip,
        coordinatorName: coordinator.name,
        memberUuids: members.map((m) => m.uuid),
        members,
        // The Sonos app labels a group by its coordinator plus a count of the rest.
        name: members.length === 1 ? coordinator.name : `${coordinator.name} + ${members.length - 1}`,
        size: members.length,
      });
    }

    // A vanished device is one the household still remembers but cannot reach.
    const vanished = X.findAll(doc, 'VanishedDevice').map((n) => ({
      uuid: X.attr(n, 'UUID'),
      name: X.attr(n, 'ZoneName'),
      reason: X.attr(n, 'Reason'),
    }));

    rooms.sort((a, b) => a.name.localeCompare(b.name));
    groups.sort((a, b) => a.coordinatorName.localeCompare(b.coordinatorName));

    // Re-attach hardware details. Every topology event rebuilds these room objects
    // from scratch, so without this the model/serial learned by loadModels() is lost
    // the first time anyone groups a room — and the UI silently drops to "unknown
    // hardware", which disables the per-model EQ controls.
    for (const room of rooms) {
      const desc = this._modelCache.get(room.uuid);
      if (desc) {
        room.model = desc.model;
        room.modelName = desc.modelName;
        room.serial = desc.serial;
        room.zoneType = desc.zoneType;
      }
    }

    const previousSignature = this.signature;
    this.groups = groups;
    this.rooms = rooms;
    this.devices = devices;
    this.vanished = vanished;
    this.updatedAt = Date.now();

    if (this.signature !== previousSignature) this.emit('change', this);
  }

  /** Stable fingerprint of the current grouping — cheap change detection. */
  get signature() {
    return this.groups
      .map((g) => `${g.coordinatorUuid}:${g.memberUuids.slice().sort().join(',')}`)
      .sort()
      .join('|');
  }

  // ---- Lookups ----

  roomByName(name) {
    if (!name) return null;
    const needle = String(name).toLowerCase();
    return this.rooms.find((r) => r.name.toLowerCase() === needle) || null;
  }

  roomByUuid(uuid) {
    return this.rooms.find((r) => r.uuid === uuid) || null;
  }

  groupById(groupId) {
    return this.groups.find((g) => g.id === groupId) || null;
  }

  groupFor(roomName) {
    const room = this.roomByName(roomName);
    if (!room) return null;
    return this.groupById(room.groupId);
  }

  /**
   * The device that owns playback for a room. Transport commands (Play, Pause, Next,
   * Seek, SetAVTransportURI, all queue mutation) MUST go here — sending them to a
   * grouped non-coordinator member fails or desynchronises the group.
   */
  coordinatorFor(roomName) {
    const group = this.groupFor(roomName);
    if (!group) return null;
    return { uuid: group.coordinatorUuid, ip: group.coordinatorIp, name: group.coordinatorName };
  }

  /**
   * The device that owns per-speaker rendering for a room. Volume, mute, bass, treble
   * and EQ are per-PLAYER and must go to the room's own IP, never the coordinator.
   */
  playerFor(roomName) {
    const room = this.roomByName(roomName);
    if (!room) return null;
    return { uuid: room.uuid, ip: room.ip, name: room.name };
  }

  ipForUuid(uuid) {
    const device = this.devices.get(uuid);
    return device ? device.ip : null;
  }

  /** Enrich rooms with model/hardware info from each device's description document. */
  async loadModels() {
    const targets = this.rooms.filter((r) => r.ip && !this._modelCache.has(r.uuid));
    await Promise.all(
      targets.map(async (room) => {
        const desc = await soap.describe(room.ip);
        if (desc) this._modelCache.set(room.uuid, desc);
      })
    );
    for (const room of this.rooms) {
      const desc = this._modelCache.get(room.uuid);
      if (desc) {
        room.model = desc.model;
        room.modelName = desc.modelName;
        room.serial = desc.serial;
        room.zoneType = desc.zoneType;
      }
    }
    return this;
  }

  /** Serialisable view for the API/UI. */
  toJSON() {
    return {
      updatedAt: this.updatedAt,
      groups: this.groups.map((g) => ({
        id: g.id,
        name: g.name,
        size: g.size,
        coordinatorUuid: g.coordinatorUuid,
        coordinatorName: g.coordinatorName,
        memberUuids: g.memberUuids,
      })),
      rooms: this.rooms.map((r) => ({
        uuid: r.uuid,
        name: r.name,
        ip: r.ip,
        model: r.model || null,
        groupId: r.groupId,
        isCoordinator: r.isCoordinator,
        coordinatorUuid: r.coordinatorUuid,
        bonding: r.bonding,
        bondedCount: r.bonded.length,
        airPlay: r.airPlay,
        hdmiCec: r.hdmiCec,
      })),
      vanished: this.vanished || [],
    };
  }
}

module.exports = { Topology, describeBonding, ipFromLocation, SETTLE_MS };
