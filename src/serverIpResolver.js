'use strict';

const dns = require('dns');
const net = require('net');

/**
 * Resolves a profile's server address to an IP for display purposes only.
 * Completely independent of the connect flow — never called from
 * coreManager.start(), so a slow/failed DNS lookup here can never delay or
 * break the actual proxy connection.
 */
function resolveServerIp(address, timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (net.isIP(address)) {
      return resolve({ ok: true, ip: address, wasLiteral: true });
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: 'زمان تفکیک DNS به پایان رسید' });
    }, timeoutMs);

    dns.lookup(address, { family: 0 }, (err, ip) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true, ip, wasLiteral: false });
    });
  });
}

module.exports = { resolveServerIp };
