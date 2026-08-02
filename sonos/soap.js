// sonos/soap.js — UPnP/SOAP transport for Sonos ZonePlayers.
//
// Every Sonos speaker exposes a set of UPnP services on port 1400. This module owns
// the wire format and nothing else: envelope construction, the SOAPACTION header,
// timeouts, retries, per-device request serialisation, and UPnP fault decoding.
//
// Verified against Sonos S2 firmware 96.0-78270 (Amp, Arc, One, Play:1, Play:3, Move).

'use strict';

const X = require('./xml');

const PORT = 1400;
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_RETRIES = 1;

// ---- Service catalogue -------------------------------------------------------
//
// `urn` differs per service: most are schemas-upnp-org, but Sonos's own Queue
// service lives under schemas-sonos-com. Getting this wrong yields a silent 500.

const SERVICES = {
  AVTransport: {
    path: '/MediaRenderer/AVTransport/Control',
    event: '/MediaRenderer/AVTransport/Event',
    urn: 'urn:schemas-upnp-org:service:AVTransport:1',
  },
  RenderingControl: {
    path: '/MediaRenderer/RenderingControl/Control',
    event: '/MediaRenderer/RenderingControl/Event',
    urn: 'urn:schemas-upnp-org:service:RenderingControl:1',
  },
  GroupRenderingControl: {
    path: '/MediaRenderer/GroupRenderingControl/Control',
    event: '/MediaRenderer/GroupRenderingControl/Event',
    urn: 'urn:schemas-upnp-org:service:GroupRenderingControl:1',
  },
  ContentDirectory: {
    path: '/MediaServer/ContentDirectory/Control',
    event: '/MediaServer/ContentDirectory/Event',
    urn: 'urn:schemas-upnp-org:service:ContentDirectory:1',
  },
  Queue: {
    path: '/MediaRenderer/Queue/Control',
    event: '/MediaRenderer/Queue/Event',
    urn: 'urn:schemas-sonos-com:service:Queue:1',
  },
  ZoneGroupTopology: {
    path: '/ZoneGroupTopology/Control',
    event: '/ZoneGroupTopology/Event',
    urn: 'urn:schemas-upnp-org:service:ZoneGroupTopology:1',
  },
  DeviceProperties: {
    path: '/DeviceProperties/Control',
    event: '/DeviceProperties/Event',
    urn: 'urn:schemas-upnp-org:service:DeviceProperties:1',
  },
  AlarmClock: {
    path: '/AlarmClock/Control',
    event: '/AlarmClock/Event',
    urn: 'urn:schemas-upnp-org:service:AlarmClock:1',
  },
  MusicServices: {
    path: '/MusicServices/Control',
    event: '/MusicServices/Event',
    urn: 'urn:schemas-upnp-org:service:MusicServices:1',
  },
  AudioIn: {
    path: '/AudioIn/Control',
    event: '/AudioIn/Event',
    urn: 'urn:schemas-upnp-org:service:AudioIn:1',
  },
  SystemProperties: {
    path: '/SystemProperties/Control',
    event: '/SystemProperties/Event',
    urn: 'urn:schemas-upnp-org:service:SystemProperties:1',
  },
  GroupManagement: {
    path: '/GroupManagement/Control',
    event: '/GroupManagement/Event',
    urn: 'urn:schemas-upnp-org:service:GroupManagement:1',
  },
};

// ---- UPnP fault codes --------------------------------------------------------
//
// These are the ones that actually show up in practice. 701 and 402 in particular
// are load-bearing: the app uses them to detect "this device does not support that"
// rather than "the network is broken", and must not retry them.

const UPNP_ERRORS = {
  401: 'Invalid action — this firmware does not implement it',
  402: 'Invalid arguments',
  501: 'Action failed',
  600: 'Argument value invalid',
  701: 'No such object',
  702: 'Invalid CurrentTagValue',
  711: 'Restricted object',
  712: 'Bad metadata',
  714: 'Unsupported or invalid URI',
  716: 'Resource not found',
  718: 'Invalid InstanceID',
  740: 'Transition not available',
  800: 'Command not supported by this device',
  806: 'Invalid session / service not session-based',
  1023: 'Not a group coordinator',
};

/** Errors that mean "the device answered, and the answer is no" — never retry these. */
const TERMINAL_CODES = new Set([401, 402, 600, 701, 702, 711, 712, 714, 716, 718, 800, 806, 1023]);

class SonosError extends Error {
  constructor(message, { ip, action, service, code, httpStatus, body } = {}) {
    super(message);
    this.name = 'SonosError';
    this.ip = ip;
    this.action = action;
    this.service = service;
    this.code = code;
    this.httpStatus = httpStatus;
    this.body = body;
  }

  /** True when the device explicitly refused — retrying will not help. */
  get terminal() {
    return this.code != null && TERMINAL_CODES.has(this.code);
  }

  /** True when the device does not support this feature at all. */
  get unsupported() {
    return this.code === 401 || this.code === 800 || this.code === 402;
  }
}

// ---- Per-device serialisation ------------------------------------------------
//
// Sonos players are small embedded devices. Firing 8 concurrent SOAP calls at one
// speaker reliably produces truncated responses and spurious 500s, especially on
// older Play:1/Play:3 hardware. We cap in-flight requests per IP; across the 20-zone
// household calls still fan out fully in parallel.

const MAX_INFLIGHT_PER_DEVICE = 3;
const deviceQueues = new Map(); // ip -> { active, waiting[] }

function acquire(ip) {
  let q = deviceQueues.get(ip);
  if (!q) {
    q = { active: 0, waiting: [] };
    deviceQueues.set(ip, q);
  }
  if (q.active < MAX_INFLIGHT_PER_DEVICE) {
    q.active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => q.waiting.push(resolve));
}

function release(ip) {
  const q = deviceQueues.get(ip);
  if (!q) return;
  const next = q.waiting.shift();
  if (next) next();
  else q.active = Math.max(0, q.active - 1);
}

// ---- Envelope ----------------------------------------------------------------

function buildEnvelope(urn, action, argsXml) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body>' +
    `<u:${action} xmlns:u="${urn}">${argsXml}</u:${action}>` +
    '</s:Body></s:Envelope>'
  );
}

/**
 * Serialise an argument object into SOAP argument XML.
 * Order matters to some Sonos actions, so we rely on JS object insertion order
 * and callers are expected to declare arguments in the documented order.
 * `null`/`undefined` values become empty elements (which several actions require —
 * e.g. an empty CurrentURIMetaData, or an empty sleep-timer duration to cancel).
 */
function buildArgs(args) {
  if (!args) return '';
  if (typeof args === 'string') return args;
  let out = '';
  for (const [key, value] of Object.entries(args)) {
    out += `<${key}>${value === null || value === undefined ? '' : X.escapeXml(value)}</${key}>`;
  }
  return out;
}

// ---- Request -----------------------------------------------------------------

/**
 * Invoke a SOAP action on a device.
 *
 * @param {string} ip           Device IP
 * @param {string} serviceName  Key of SERVICES
 * @param {string} action       SOAP action name
 * @param {Object|string} args  Arguments, in documented order
 * @param {Object} [opts]
 * @param {number} [opts.timeout]
 * @param {number} [opts.retries]
 * @returns {Promise<XmlNode>}  The parsed `<u:...Response>` node
 * @throws {SonosError}
 */
async function request(ip, serviceName, action, args, opts = {}) {
  const service = SERVICES[serviceName];
  if (!service) throw new SonosError(`Unknown service: ${serviceName}`, { ip, action });

  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.retries ?? DEFAULT_RETRIES;
  const body = buildEnvelope(service.urn, action, buildArgs(args));
  const url = `http://${ip}:${PORT}${service.path}`;

  await acquire(ip);
  try {
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            SOAPACTION: `"${service.urn}#${action}"`,
            Connection: 'close',
          },
          body,
          signal: controller.signal,
        });
        const responseText = await res.text();

        if (!res.ok) {
          const doc = X.parseXml(responseText);
          const code = X.int(doc, 'errorCode', null);
          const err = new SonosError(
            code
              ? `${serviceName}.${action} @ ${ip} → UPnP ${code}: ${UPNP_ERRORS[code] || 'unknown'}`
              : `${serviceName}.${action} @ ${ip} → HTTP ${res.status}`,
            { ip, action, service: serviceName, code, httpStatus: res.status, body: responseText }
          );
          // A refusal is an answer. Only genuine server-side flakiness is retried.
          if (err.terminal || attempt === maxRetries) throw err;
          lastError = err;
          continue;
        }

        const doc = X.parseXml(responseText);
        const response = X.find(doc, `${action}Response`);
        // Some actions (Play, Pause) return an empty response body; the Body node
        // is then the only meaningful anchor.
        return response || X.find(doc, 'Body') || doc;
      } catch (e) {
        if (e instanceof SonosError) throw e;
        const wrapped = new SonosError(
          e.name === 'AbortError'
            ? `${serviceName}.${action} @ ${ip} timed out after ${timeout}ms`
            : `${serviceName}.${action} @ ${ip} → ${e.message}`,
          { ip, action, service: serviceName }
        );
        wrapped.cause = e;
        if (attempt === maxRetries) throw wrapped;
        lastError = wrapped;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  } finally {
    release(ip);
  }
}

/**
 * Like `request`, but returns `fallback` instead of throwing when the device
 * simply does not support the action. Genuine network failures still throw.
 * This is how per-model capability probing stays terse at the call site.
 */
async function tryRequest(ip, serviceName, action, args, fallback = null, opts = {}) {
  try {
    return await request(ip, serviceName, action, args, opts);
  } catch (e) {
    if (e instanceof SonosError && (e.unsupported || e.code === 701)) return fallback;
    throw e;
  }
}

/** Fetch and parse a device's description document. */
async function describe(ip, timeout = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`http://${ip}:${PORT}/xml/device_description.xml`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const doc = X.parseXml(await res.text());
    const device = X.find(doc, 'device');
    if (!device) return null;
    return {
      ip,
      uuid: (X.text(device, 'UDN') || '').replace(/^uuid:/, ''),
      room: X.text(device, 'roomName'),
      model: X.text(device, 'displayName') || X.text(device, 'modelName'),
      modelName: X.text(device, 'modelName'),
      modelNumber: X.text(device, 'modelNumber'),
      serial: X.text(device, 'serialNum'),
      software: X.text(device, 'softwareVersion'),
      hardware: X.text(device, 'hardwareVersion'),
      zoneType: X.text(device, 'zoneType'),
      icon: X.text(device, 'iconList') ? null : null,
    };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  PORT,
  SERVICES,
  SonosError,
  UPNP_ERRORS,
  request,
  tryRequest,
  describe,
  buildArgs,
  buildEnvelope,
};
