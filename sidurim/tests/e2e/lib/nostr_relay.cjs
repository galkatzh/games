// tests/e2e/lib/nostr_relay.cjs — WP-NET
// A Nostr relay small enough to read, for tests/e2e/online.e2e.cjs. Trystero finds peers by publishing short-lived events to relays
// and subscribing to them by kind and by an `x` tag. This one keeps nothing: it answers each event with OK, hands it to every open
// subscription whose filter it fits, and answers each subscription with EOSE. That is all two browsers on one machine need to find
// each other, and it lets the real vendor/trystero.min.js run with no internet.
//
// The WebSocket side is written out here because tools and tests use no npm packages (README). Text frames only, as Nostr sends.
'use strict';

const crypto = require('node:crypto');
const http = require('node:http');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** @returns {Buffer} One unmasked frame, as a server sends them. */
function frame(opcode, payload) {
  const n = payload.length;
  let head;
  if (n < 126) {
    head = Buffer.from([0x80 | opcode, n]);
  } else if (n < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

/**
 * Reads whole frames off the front of a buffer.
 * @param {Buffer} buf Bytes received so far.
 * @param {function(number, Buffer, boolean): void} onFrame Called with opcode, unmasked payload and the FIN bit.
 * @returns {Buffer} What is left: the start of a frame not all here yet.
 */
function readFrames(buf, onFrame) {
  let at = 0;
  for (;;) {
    if (buf.length - at < 2) break;
    const fin = (buf[at] & 0x80) !== 0;
    const opcode = buf[at] & 0x0f;
    const masked = (buf[at + 1] & 0x80) !== 0;
    let len = buf[at + 1] & 0x7f;
    let head = 2;
    if (len === 126) {
      if (buf.length - at < 4) break;
      len = buf.readUInt16BE(at + 2);
      head = 4;
    } else if (len === 127) {
      if (buf.length - at < 10) break;
      len = Number(buf.readBigUInt64BE(at + 2));
      head = 10;
    }
    const maskAt = at + head;
    const dataAt = maskAt + (masked ? 4 : 0);
    if (buf.length < dataAt + len) break;
    const payload = Buffer.from(buf.subarray(dataAt, dataAt + len));
    if (masked) {
      for (let i = 0; i < len; i++) payload[i] ^= buf[maskAt + (i & 3)];
    }
    onFrame(opcode, payload, fin);
    at = dataAt + len;
  }
  return buf.subarray(at);
}

/** @returns {boolean} True when an event fits one filter of NIP-01, as far as Trystero uses it: kinds, and tags by letter. */
function fits(filter, event) {
  if (!filter || typeof filter !== 'object') return false;
  if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) return false;
  for (const key of Object.keys(filter)) {
    if (key[0] !== '#' || !Array.isArray(filter[key])) continue;
    const letter = key.slice(1);
    const tags = Array.isArray(event.tags) ? event.tags : [];
    if (!tags.some((t) => Array.isArray(t) && t[0] === letter && filter[key].includes(t[1]))) return false;
  }
  return true;
}

/**
 * Starts a relay on a free local port.
 * @returns {Promise<{url:string, stats:{clients:number, events:number, subs:number}, close:function():Promise<void>}>} url is ws://.
 */
function start() {
  const clients = new Set();
  const stats = { clients: 0, events: 0, subs: 0 };
  const server = http.createServer((req, res) => {
    res.writeHead(426);
    res.end('a websocket relay');
  });

  function sendJson(client, value) {
    if (!client.socket.destroyed) client.socket.write(frame(1, Buffer.from(JSON.stringify(value), 'utf8')));
  }

  function onText(client, text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      return;
    }
    if (!Array.isArray(msg)) return;
    if (msg[0] === 'EVENT' && msg[1] && typeof msg[1] === 'object') {
      const event = msg[1];
      stats.events++;
      sendJson(client, ['OK', event.id, true, '']);
      for (const other of clients) {
        for (const [subId, filters] of other.subs) {
          if (filters.some((f) => fits(f, event))) sendJson(other, ['EVENT', subId, event]);
        }
      }
    } else if (msg[0] === 'REQ' && typeof msg[1] === 'string') {
      stats.subs++;
      client.subs.set(msg[1], msg.slice(2));
      sendJson(client, ['EOSE', msg[1]]);
    } else if (msg[0] === 'CLOSE' && typeof msg[1] === 'string') {
      client.subs.delete(msg[1]);
    }
  }

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
    const client = { socket, subs: new Map(), rest: Buffer.alloc(0), parts: [] };
    clients.add(client);
    stats.clients++;
    socket.on('data', (chunk) => {
      client.rest = readFrames(Buffer.concat([client.rest, chunk]), (opcode, payload, fin) => {
        if (opcode === 8) {
          socket.end(frame(8, Buffer.alloc(0)));
        } else if (opcode === 9) {
          socket.write(frame(10, payload));
        } else if (opcode === 1 || opcode === 0) {
          client.parts.push(payload);
          if (!fin) return;
          const whole = Buffer.concat(client.parts).toString('utf8');
          client.parts = [];
          onText(client, whole);
        }
      });
    });
    const gone = () => clients.delete(client);
    socket.on('close', gone);
    socket.on('error', gone);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `ws://127.0.0.1:${server.address().port}`,
        stats,
        close: () => new Promise((done) => {
          for (const c of clients) c.socket.destroy();
          server.close(() => done());
        })
      });
    });
  });
}

module.exports = { start, fits, frame, readFrames };
