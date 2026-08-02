// sonos/presets.js — Built-in internet radio stations.
//
// This household has zero radio favourites (ContentDirectory R:0/0 is empty) and no
// indexed local library, so without these there is nothing to play that does not
// require a music service. SomaFM is listener-supported, has no ads and no auth, and
// its MP3 endpoints work directly with x-rincon-mp3radio.
//
// These are STREAMS: SetAVTransportURI then Play. They bypass the queue entirely,
// and Next/Previous are invalid while one is playing.

'use strict';

const didl = require('./didl');

const STATIONS = [
  { id: 'groovesalad', label: 'Groove Salad', emoji: '🌊', genre: 'Ambient / downtempo', host: 'ice1.somafm.com', mount: 'groovesalad-128-mp3' },
  { id: 'sonicuniverse', label: 'Sonic Universe', emoji: '🎷', genre: 'Modern jazz', host: 'ice1.somafm.com', mount: 'sonicuniverse-128-mp3' },
  { id: 'deepspaceone', label: 'Deep Space One', emoji: '🌌', genre: 'Deep ambient', host: 'ice1.somafm.com', mount: 'deepspaceone-128-mp3' },
  { id: 'dronezone', label: 'Drone Zone', emoji: '🛸', genre: 'Atmospheric', host: 'ice1.somafm.com', mount: 'dronezone-128-mp3' },
  { id: 'bootliquor', label: 'Boot Liquor', emoji: '🥃', genre: 'Americana', host: 'ice1.somafm.com', mount: 'bootliquor-128-mp3' },
  { id: 'indiepop', label: 'Indie Pop Rocks', emoji: '🎸', genre: 'Indie pop', host: 'ice1.somafm.com', mount: 'indiepop-128-mp3' },
  { id: 'lush', label: 'Lush', emoji: '💫', genre: 'Vocal electronica', host: 'ice1.somafm.com', mount: 'lush-128-mp3' },
  { id: 'secretagent', label: 'Secret Agent', emoji: '🕵️', genre: 'Spy jazz / lounge', host: 'ice1.somafm.com', mount: 'secretagent-128-mp3' },
  { id: 'poptron', label: 'PopTron', emoji: '⚡', genre: 'Electropop', host: 'ice1.somafm.com', mount: 'poptron-128-mp3' },
  { id: 'seventies', label: 'Left Coast 70s', emoji: '🕺', genre: 'Mellow 70s', host: 'ice1.somafm.com', mount: 'seventies-128-mp3' },
  { id: 'christmas', label: 'Christmas Lounge', emoji: '🎄', genre: 'Seasonal', host: 'ice1.somafm.com', mount: 'christmas-128-mp3', seasonal: true },
];

/** Stations formatted as playable items, matching the shape playItem() expects. */
function list({ includeSeasonal = false } = {}) {
  const month = new Date().getMonth(); // 11 = December
  return STATIONS.filter((s) => !s.seasonal || includeSeasonal || month === 11).map((station) => {
    const uri = `x-rincon-mp3radio://${station.host}/${station.mount}`;
    return {
      id: station.id,
      kind: 'radio',
      playAs: 'stream',
      title: station.label,
      artist: station.genre,
      emoji: station.emoji,
      service: 'SomaFM',
      art: null,
      uri,
      // Radio needs an audioBroadcast class or some players show a blank title.
      metadata: didl.buildMetadata({
        id: `R:0/0/${station.id}`,
        title: station.label,
        upnpClass: didl.UPNP_CLASS.stream,
        token: '',
      }),
      playable: true,
    };
  });
}

function byId(id) {
  return list({ includeSeasonal: true }).find((s) => s.id === id) || null;
}

module.exports = { list, byId, STATIONS };
