// sonos/xml.js — A small, dependency-free, tolerant XML parser + builder.
//
// Why not regex? Sonos DIDL-Lite payloads nest arbitrarily (<item> containing
// <desc>, <res>, repeated <upnp:albumArtURI>), arrive double-escaped inside SOAP
// responses, and carry namespace prefixes that vary by firmware. Regex extraction
// silently returns the *first* match anywhere in the document, which is how third-party
// Sonos clients end up showing the wrong track's album art. A real parse is ~150 lines
// and removes the entire class of bug.
//
// Deliberately NOT a spec-complete XML parser: no DTDs, no entities beyond the
// predefined five + numeric, no namespace resolution (we key on the local name).
// That is exactly the subset Sonos emits.

'use strict';

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Decode XML entities, including numeric (&#38; / &#x26;).
 * Sonos double-escapes DIDL inside SOAP, so this is often applied twice.
 */
function decodeEntities(str) {
  if (typeof str !== 'string' || str.indexOf('&') === -1) return str;
  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch (_) {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? match : named;
  });
}

/** Escape a value for inclusion in XML text or an attribute. */
function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * An XML node.
 * @typedef {Object} XmlNode
 * @property {string} name       Local name, namespace prefix stripped ("title")
 * @property {string} qname      Qualified name as it appeared ("dc:title")
 * @property {Object} attrs      Attributes keyed by qualified name
 * @property {XmlNode[]} children
 * @property {string} text       Direct text content, entity-decoded
 */

function makeNode(qname) {
  const colon = qname.indexOf(':');
  return {
    name: colon === -1 ? qname : qname.slice(colon + 1),
    qname,
    attrs: {},
    children: [],
    text: '',
  };
}

const ATTR_RE = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseAttrs(node, source) {
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(source)) !== null) {
    const raw = m[3] !== undefined ? m[3] : m[4];
    node.attrs[m[1]] = decodeEntities(raw);
  }
}

/**
 * Parse an XML document into a tree.
 * Returns a synthetic root node whose children are the document's top-level elements.
 * Malformed input degrades rather than throwing — Sonos occasionally emits stray
 * unescaped ampersands in user-supplied room names.
 *
 * @param {string} xml
 * @returns {XmlNode}
 */
function parseXml(xml) {
  const root = makeNode('#document');
  if (typeof xml !== 'string' || xml.length === 0) return root;

  const stack = [root];
  let i = 0;
  const len = xml.length;

  while (i < len) {
    const lt = xml.indexOf('<', i);

    // Trailing / interstitial text belongs to the current open element.
    if (lt === -1) {
      appendText(stack[stack.length - 1], xml.slice(i));
      break;
    }
    if (lt > i) appendText(stack[stack.length - 1], xml.slice(i, lt));

    // CDATA — content is taken verbatim, no entity decoding.
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      const stop = end === -1 ? len : end;
      const node = stack[stack.length - 1];
      node.text += xml.slice(lt + 9, stop);
      i = end === -1 ? len : end + 3;
      continue;
    }

    // Comments, doctypes, processing instructions — skipped wholesale.
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt);
      i = end === -1 ? len : end + 1;
      continue;
    }

    const gt = findTagEnd(xml, lt);
    if (gt === -1) {
      // Unterminated tag — treat the remainder as text rather than losing it.
      appendText(stack[stack.length - 1], xml.slice(lt));
      break;
    }

    const inner = xml.slice(lt + 1, gt);
    i = gt + 1;

    if (inner[0] === '/') {
      // Closing tag: unwind to the matching open element. Tolerates mismatches.
      const closing = inner.slice(1).trim();
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].qname === closing) {
          stack.length = s;
          break;
        }
      }
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = /^[\w:.-]+/.exec(body);
    if (!nameMatch) continue;

    const node = makeNode(nameMatch[0]);
    parseAttrs(node, body.slice(nameMatch[0].length));
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

function appendText(node, chunk) {
  if (!chunk) return;
  node.text += decodeEntities(chunk);
}

/**
 * Find the '>' that closes a tag starting at `lt`, skipping any '>' that appears
 * inside a quoted attribute value. Sonos room names and DIDL URIs contain both.
 */
function findTagEnd(xml, lt) {
  let quote = null;
  for (let j = lt + 1; j < xml.length; j++) {
    const ch = xml[j];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return j;
    }
  }
  return -1;
}

// ---- Tree query helpers (all match on LOCAL name, prefix-insensitive) ----

/** First direct child with the given local name. */
function child(node, name) {
  if (!node) return null;
  for (const c of node.children) if (c.name === name) return c;
  return null;
}

/** All direct children with the given local name. */
function children(node, name) {
  if (!node) return [];
  return name ? node.children.filter((c) => c.name === name) : node.children.slice();
}

/** First descendant (depth-first, any depth) with the given local name. */
function find(node, name) {
  if (!node) return null;
  for (const c of node.children) {
    if (c.name === name) return c;
    const deeper = find(c, name);
    if (deeper) return deeper;
  }
  return null;
}

/** All descendants with the given local name, depth-first. */
function findAll(node, name, out = []) {
  if (!node) return out;
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

/**
 * Text of the first descendant with the given local name, or `fallback`.
 * This is the workhorse for pulling scalars out of SOAP responses.
 */
function text(node, name, fallback = null) {
  if (!name) return node ? node.text.trim() : fallback;
  const found = find(node, name);
  if (!found) return fallback;
  const value = found.text.trim();
  return value === '' ? fallback : value;
}

/** Integer form of `text`, with NaN guarded. */
function int(node, name, fallback = null) {
  const raw = text(node, name, null);
  if (raw == null) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Attribute of a node, or fallback. */
function attr(node, name, fallback = null) {
  if (!node) return fallback;
  const value = node.attrs[name];
  return value === undefined ? fallback : value;
}

/** Build an XML element string from a tag, attrs object and inner content. */
function element(tag, attrs, inner) {
  const parts = [tag];
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      parts.push(`${k}="${escapeXml(v)}"`);
    }
  }
  const open = parts.join(' ');
  if (inner === undefined || inner === null || inner === '') return `<${open}/>`;
  return `<${open}>${inner}</${tag}>`;
}

module.exports = {
  parseXml,
  decodeEntities,
  escapeXml,
  child,
  children,
  find,
  findAll,
  text,
  int,
  attr,
  element,
};
