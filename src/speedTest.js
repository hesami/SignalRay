'use strict';

const https = require('https');
const crypto = require('crypto');
const { HttpsProxyAgent } = require('https-proxy-agent');

/**
 * Real throughput test — downloads/uploads actual bytes through the local
 * HTTP proxy (i.e. through the live tunnel), the same approach v2rayN and
 * similar clients use, rather than just measuring latency. Uses Cloudflare's
 * public speed-test endpoints (the same ones speed.cloudflare.com's own page
 * uses), which accept arbitrary byte counts with no auth required.
 */

const DEFAULT_DOWNLOAD_URL = 'https://speed.cloudflare.com/__down?bytes=';
const DEFAULT_UPLOAD_URL = 'https://speed.cloudflare.com/__up';

function proxyAgentFor(httpPort) {
  return new HttpsProxyAgent(`http://127.0.0.1:${httpPort}`);
}

/**
 * Downloads `bytes` through the proxy and reports throughput. Resolves early
 * once `bytes` have been received even if the server would send more.
 */
function downloadTest(httpPort, { bytes = 10_000_000, timeoutMs = 20000, url } = {}) {
  const targetUrl = (url || DEFAULT_DOWNLOAD_URL + bytes);
  return new Promise((resolve) => {
    const agent = proxyAgentFor(httpPort);
    const start = Date.now();
    let received = 0;
    let settled = false;

    const req = https.get(targetUrl, { agent, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return finish({ ok: false, error: `HTTP ${res.statusCode}` });
      }
      res.on('data', (chunk) => {
        received += chunk.length;
      });
      res.on('end', () => {
        const seconds = (Date.now() - start) / 1000;
        finish({ ok: true, bytes: received, seconds, mbps: seconds > 0 ? (received * 8) / seconds / 1_000_000 : 0 });
      });
      res.on('error', (err) => finish({ ok: false, error: err.message }));
    });

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, error: 'زمان تست دانلود به پایان رسید' });
    });
    req.on('error', (err) => finish({ ok: false, error: err.message }));

    function finish(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }
  });
}

/**
 * Uploads `bytes` of random data through the proxy and reports throughput.
 */
function uploadTest(httpPort, { bytes = 5_000_000, timeoutMs = 20000, url } = {}) {
  const targetUrl = url || DEFAULT_UPLOAD_URL;
  return new Promise((resolve) => {
    const agent = proxyAgentFor(httpPort);
    const body = crypto.randomBytes(bytes);
    const start = Date.now();
    let settled = false;

    const req = https.request(
      targetUrl,
      { method: 'POST', agent, timeout: timeoutMs, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length } },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          const seconds = (Date.now() - start) / 1000;
          finish({ ok: true, bytes: body.length, seconds, mbps: seconds > 0 ? (body.length * 8) / seconds / 1_000_000 : 0 });
        });
        res.on('error', (err) => finish({ ok: false, error: err.message }));
      }
    );

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, error: 'زمان تست آپلود به پایان رسید' });
    });
    req.on('error', (err) => finish({ ok: false, error: err.message }));
    req.end(body);

    function finish(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }
  });
}

/** Runs download then upload and returns both results together. */
async function runSpeedTest(httpPort, options = {}) {
  const download = await downloadTest(httpPort, options.download);
  const upload = await uploadTest(httpPort, options.upload);
  return { download, upload };
}

module.exports = { downloadTest, uploadTest, runSpeedTest };
