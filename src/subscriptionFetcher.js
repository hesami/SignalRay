'use strict';

const https = require('https');
const http = require('http');
const { parseBulk } = require('./profileParser');

/**
 * Parses the semi-standard `Subscription-Userinfo` response header used by
 * most subscription panels (x-ui, 3x-ui, Marzban, etc.) to report quota:
 *   Subscription-Userinfo: upload=123; download=456; total=789000000; expire=1750000000
 */
function parseUserinfo(headerValue) {
  if (!headerValue) return null;
  const out = {};
  for (const part of headerValue.split(';')) {
    const [k, v] = part.trim().split('=');
    if (!k || v === undefined) continue;
    out[k.trim()] = Number(v.trim());
  }
  if (Object.keys(out).length === 0) return null;
  return {
    upload: out.upload || 0,
    download: out.download || 0,
    total: out.total || 0,
    expire: out.expire || 0 // unix seconds, 0 = no expiry given
  };
}

function looksLikeBase64(text) {
  const trimmed = text.trim().replace(/\s+/g, '');
  if (trimmed.length < 8) return false;
  return /^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed);
}

function decodeBody(body) {
  const trimmed = body.trim();
  // Plain subscription content is just newline-separated share links.
  if (/^(vless|vmess|trojan):\/\//im.test(trimmed)) return trimmed;
  if (looksLikeBase64(trimmed)) {
    try {
      const decoded = Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (/^(vless|vmess|trojan):\/\//im.test(decoded.trim())) return decoded;
    } catch (e) {
      /* fall through and return the raw body */
    }
  }
  return trimmed;
}

function fetchOnce(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'SignalRay-App/1.0' }, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('تعداد ریدایرکت‌ها بیش از حد مجاز بود'));
        return resolve(fetchOnce(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`دریافت سابسکریپشن ناموفق بود (کد HTTP ${res.statusCode})`));
      }
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ body, headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('زمان دریافت سابسکریپشن به پایان رسید')));
    req.on('error', reject);
  });
}

/**
 * Fetches a subscription URL, decodes its contents into individual proxy
 * profiles, and pulls out quota/expiry info when the panel provides it.
 */
async function fetchSubscription(url) {
  const { body, headers } = await fetchOnce(url);
  const decoded = decodeBody(body);
  const { profiles, errors } = parseBulk(decoded);
  const userinfo = parseUserinfo(headers['subscription-userinfo']);
  return { profiles, errors, userinfo };
}

module.exports = { fetchSubscription, parseUserinfo, decodeBody };
