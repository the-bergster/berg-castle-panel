// sonos/didl.js — DIDL-Lite parsing, URI classification, and metadata construction.
//
// This is where third-party Sonos clients go wrong, so the rules below were derived
// from THIS household's own favourites rather than from folklore.
//
// A URI tells you how it must be played, and the three cases are not interchangeable:
//
//   CONTAINER  x-rincon-cpcontainer:  album / playlist
//              -> SetAVTransportURI(containerUri, containerMetadata). REPLACES the queue.
//              Calling AddURIToQueue on a container adds a single unplayable entry.
//
//   STREAM     x-sonosapi-stream: / x-sonosapi-radio: / x-rincon-mp3radio:
//              -> SetAVTransportURI(streamUri, metadata). Bypasses the queue entirely.
//              Next/Previous are invalid; the UI must disable them.
//
//   TRACK      x-sonos-spotify: / x-sonos-http: / x-file-cifs:
//              -> AddURIToQueue(trackUri, trackMetadata), then Seek(TRACK_NR) + Play.
//              Calling SetAVTransportURI on a track works but silently destroys the queue.
//
// The `desc` token that must accompany service content follows
//   SA_RINCON<sid*256 + 7>_X_#Svc<sid*256 + 7>-0-Token
// verified here against Spotify (12 -> 3079), Apple Music (204 -> 52231) and
// Sonos Radio (303 -> 77575). The `sn=` parameter in the URI is a *different* number
// (the account serial) and must be carried through verbatim.

'use strict';

const X = require('./xml');

const DIDL_NS =
  'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
  'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" ' +
  'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"';

/** Account type embedded in the SA_RINCON token for OAuth-linked services. */
const OAUTH_ACCOUNT_TYPE = 7;

/** Service ids seen in this household, plus the common ones worth labelling. */
const SERVICE_NAMES = {
  12: 'Spotify',
  204: 'Apple Music',
  303: 'Sonos Radio',
  254: 'TuneIn',
  333: 'TuneIn',
  516: 'SomaFM',
  201: 'Amazon Music',
  174: 'TIDAL',
  160: 'SoundCloud',
  31: 'Qobuz',
  2: 'Deezer',
  236: 'Pandora',
  284: 'YouTube Music',
  37: 'SiriusXM',
  212: 'Plex',
};

/** Item-id prefix per content kind. The low 4 hex digits encode the flags value. */
const ID_PREFIX = { track: '1003', album: '1004', playlist: '1006' };

/** upnp:class per content kind. */
const UPNP_CLASS = {
  track: 'object.item.audioItem.musicTrack',
  album: 'object.container.album.musicAlbum',
  playlist: 'object.container.playlistContainer',
  artist: 'object.container.person.musicArtist',
  stream: 'object.item.audioItem.audioBroadcast',
};

/** Compose the SA_RINCON descriptor token for a service id. */
function serviceToken(sid, accountType = OAUTH_ACCOUNT_TYPE) {
  const n = Number(sid) * 256 + Number(accountType);
  return `SA_RINCON${n}_X_#Svc${n}-0-Token`;
}

/** Build the item id whose low half encodes the flags, e.g. track+8232 -> "10032028". */
function itemId(kind, flags) {
  const prefix = ID_PREFIX[kind] || ID_PREFIX.track;
  return prefix + Number(flags).toString(16).padStart(4, '0');
}

/** Pull the sid/sn/flags query parameters out of a Sonos URI. */
function uriParams(uri) {
  const q = String(uri || '').split('?')[1];
  if (!q) return {};
  const out = {};
  for (const pair of q.split('&')) {
    const [k, v] = pair.split('=');
    if (k) out[k] = v;
  }
  return {
    sid: out.sid != null ? parseInt(out.sid, 10) : null,
    sn: out.sn != null ? parseInt(out.sn, 10) : null,
    flags: out.flags != null ? parseInt(out.flags, 10) : null,
  };
}

/**
 * Classify a URI into how it must be played and what it is.
 * @returns {{ kind:string, playAs:'container'|'stream'|'track'|'special', service:string|null, sid:number|null, sn:number|null }}
 */
function classifyUri(uri) {
  const u = String(uri || '');
  const { sid, sn, flags } = uriParams(u);
  const service = sid != null ? SERVICE_NAMES[sid] || `Service ${sid}` : null;
  const base = { service, sid, sn, flags };

  if (!u) return { kind: 'none', playAs: 'special', ...base };

  // A grouped member mirrors its coordinator; there is nothing local to render.
  if (u.startsWith('x-rincon:')) {
    return { kind: 'group-member', playAs: 'special', ...base, coordinatorUuid: u.slice('x-rincon:'.length) };
  }
  // Playing from this player's own queue.
  if (u.startsWith('x-rincon-queue:')) return { kind: 'queue', playAs: 'special', ...base };
  // Another player's line-in, broadcast into this group.
  if (u.startsWith('x-rincon-stream:')) {
    return { kind: 'line-in', playAs: 'stream', ...base, service: service || 'Line-In' };
  }
  // HDMI / optical TV input on a soundbar.
  if (u.startsWith('x-sonos-htastream:')) {
    return { kind: 'tv', playAs: 'stream', ...base, service: 'TV' };
  }
  // AirPlay session.
  if (u.startsWith('x-sonos-vli:')) {
    return { kind: 'airplay', playAs: 'special', ...base, service: 'AirPlay' };
  }
  // Album or playlist from a music service.
  if (u.startsWith('x-rincon-cpcontainer:')) {
    return { kind: 'container', playAs: 'container', ...base };
  }
  // Internet radio and service-provided stations.
  if (u.startsWith('x-sonosapi-stream:') || u.startsWith('x-sonosapi-radio:') || u.startsWith('x-rincon-mp3radio:') || u.startsWith('aac:') || u.startsWith('hls-radio:')) {
    return { kind: 'radio', playAs: 'stream', ...base };
  }
  // A saved Sonos playlist (saved queue).
  if (u.startsWith('file:///jffs/settings/savedqueues.rsq')) {
    return { kind: 'sonos-playlist', playAs: 'container', ...base };
  }
  // A single track from a service or the local library.
  if (u.startsWith('x-sonos-spotify:') || u.startsWith('x-sonos-http:') || u.startsWith('x-file-cifs:') || u.startsWith('http://') || u.startsWith('https://')) {
    return { kind: 'track', playAs: 'track', ...base };
  }
  return { kind: 'unknown', playAs: 'track', ...base };
}

/**
 * Resolve a DIDL albumArtURI into something fetchable.
 * Sonos emits relative "/getaa?..." paths that only resolve against a speaker, plus
 * occasional absolute https URLs from services like Apple Music.
 */
function resolveArt(artUri, speakerIp) {
  if (!artUri) return null;
  const art = String(artUri);
  if (/^https?:\/\//i.test(art)) return art;
  if (!speakerIp) return null;
  return `http://${speakerIp}:1400${art.startsWith('/') ? '' : '/'}${art}`;
}

/** "0:03:47" -> 227 seconds. Returns null for live streams ("NOT_IMPLEMENTED", "0:00:00"). */
function durationToSeconds(value) {
  if (!value || typeof value !== 'string') return null;
  const parts = value.split(':').map((p) => parseInt(p, 10));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds > 0 ? seconds : null;
}

/** 227 -> "3:47". */
function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Normalise one parsed DIDL <item>/<container> node into a flat track object.
 * `speakerIp` is needed to make relative art URIs fetchable.
 */
function normalizeItem(node, speakerIp) {
  if (!node) return null;
  const resNode = X.find(node, 'res');
  const uri = resNode ? resNode.text.trim() : null;
  const upnpClass = X.text(node, 'class', '') || '';
  const rawArt = X.text(node, 'albumArtURI');
  const info = classifyUri(uri);

  // Radio carries the "now playing" string in r:streamContent rather than dc:title,
  // and its dc:title is the station name.
  const streamContent = X.text(node, 'streamContent');
  const title = X.text(node, 'title');
  const durationRaw = resNode ? X.attr(resNode, 'duration') : null;
  const durationSeconds = durationToSeconds(durationRaw);

  return {
    id: X.attr(node, 'id'),
    parentId: X.attr(node, 'parentID'),
    title,
    artist: X.text(node, 'creator') || X.text(node, 'artist'),
    album: X.text(node, 'album'),
    albumArtist: X.text(node, 'albumArtist'),
    art: resolveArt(rawArt, speakerIp),
    artRaw: rawArt,
    uri,
    upnpClass,
    isContainer: node.name === 'container' || upnpClass.includes('object.container'),
    durationSeconds,
    duration: formatDuration(durationSeconds),
    streamContent: streamContent || null,
    description: X.text(node, 'description'),
    // Favourites carry the *real* playable payload in r:resMD.
    resMD: X.text(node, 'resMD'),
    type: X.text(node, 'type'),
    kind: info.kind,
    playAs: info.playAs,
    service: info.service,
    sid: info.sid,
    sn: info.sn,
  };
}

/**
 * Parse a DIDL-Lite document (already unescaped once out of the SOAP <Result>)
 * into normalised items, preserving document order.
 */
function parseDidl(raw, speakerIp) {
  if (!raw) return [];
  const doc = X.parseXml(raw);
  const didl = X.find(doc, 'DIDL-Lite') || doc;
  return X.children(didl)
    .filter((n) => n.name === 'item' || n.name === 'container')
    .map((n) => normalizeItem(n, speakerIp))
    .filter(Boolean);
}

/** Parse and return only the first item — used for single-object BrowseMetadata calls. */
function parseDidlOne(raw, speakerIp) {
  const items = parseDidl(raw, speakerIp);
  return items.length ? items[0] : null;
}

/**
 * Build DIDL metadata to accompany SetAVTransportURI / AddURIToQueue.
 *
 * @param {Object} opts
 * @param {string} opts.id          Item id, e.g. "10032028spotify%3atrack%3aABC"
 * @param {string} opts.title
 * @param {string} opts.upnpClass
 * @param {string} opts.token       SA_RINCON descriptor
 * @param {string} [opts.parentId]
 * @param {string} [opts.creator]
 * @param {string} [opts.album]
 * @param {string} [opts.art]
 */
function buildMetadata({ id, title = '', upnpClass, token, parentId, creator, album, art }) {
  const parts = [
    `<dc:title>${X.escapeXml(title)}</dc:title>`,
    `<upnp:class>${upnpClass}</upnp:class>`,
  ];
  if (creator) parts.splice(1, 0, `<dc:creator>${X.escapeXml(creator)}</dc:creator>`);
  if (album) parts.push(`<upnp:album>${X.escapeXml(album)}</upnp:album>`);
  if (art) parts.push(`<upnp:albumArtURI>${X.escapeXml(art)}</upnp:albumArtURI>`);
  if (token) {
    parts.push(
      `<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">${token}</desc>`
    );
  }
  return (
    `<DIDL-Lite ${DIDL_NS}>` +
    `<item id="${X.escapeXml(id)}" parentID="${X.escapeXml(parentId || id)}" restricted="true">` +
    parts.join('') +
    '</item></DIDL-Lite>'
  );
}

/**
 * Extract the playable payload from a Sonos favourite.
 *
 * Favourites are wrappers. Most carry a direct `res` URI plus `r:resMD` holding the
 * real DIDL. "Shortcut" favourites (type="shortcut", e.g. Sonos Radio entries) have
 * an EMPTY res and are only playable via the id inside their resMD — those we surface
 * as browsable rather than instantly playable.
 *
 * @returns {{ uri:string|null, metadata:string, playAs:string, playable:boolean }}
 */
function favouritePayload(fav) {
  const metadata = fav.resMD || '';
  if (!fav.uri) {
    return { uri: null, metadata, playAs: 'shortcut', playable: false };
  }
  const info = classifyUri(fav.uri);
  return { uri: fav.uri, metadata, playAs: info.playAs, playable: true };
}

module.exports = {
  DIDL_NS,
  SERVICE_NAMES,
  UPNP_CLASS,
  OAUTH_ACCOUNT_TYPE,
  serviceToken,
  itemId,
  uriParams,
  classifyUri,
  resolveArt,
  durationToSeconds,
  formatDuration,
  normalizeItem,
  parseDidl,
  parseDidlOne,
  buildMetadata,
  favouritePayload,
};
