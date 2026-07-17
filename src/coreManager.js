'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const { EventEmitter } = require('events');
const { buildXrayConfig, buildSingboxConfig } = require('./configBuilder');

class CoreManager extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.status = 'disconnected'; // disconnected | connecting | connected | error
    this.currentProfileId = null;
    this.configPath = null;
    this.startedAt = null;
    this.corePath = null;
    this.activeCore = null;
    this.statsApiPort = null;
    this.statsTimer = null;
    this.statsRequest = null;
    this.trafficTotals = { uplink: 0, downlink: 0 };
    this._lastXrayStat = null;
  }

  _geoipAvailable(settings) {
    if (settings.activeCore === 'singbox') {
      return !!(settings.singboxGeoipIrPath && fs.existsSync(settings.singboxGeoipIrPath));
    }
    return !!(settings.geoipDatPath && fs.existsSync(settings.geoipDatPath));
  }

  _log(line) {
    this.emit('log', line);
  }

  _setStatus(status, extra) {
    this.status = status;
    this.emit('status', { status, ...extra });
  }

  getStatus() {
    return {
      status: this.status,
      profileId: this.currentProfileId,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0
    };
  }

  async start(profile, settings) {
    if (this.proc) {
      await this.stop();
    }

    const corePath = settings.activeCore === 'singbox' ? settings.corePathSingbox : settings.corePathXray;
    if (!corePath || !fs.existsSync(corePath)) {
      throw new Error(
        `مسیر هستهٔ ${settings.activeCore === 'singbox' ? 'sing-box' : 'Xray-core'} پیدا نشد. لطفاً در بخش تنظیمات مسیر فایل اجرایی را مشخص کنید.`
      );
    }

    const settingsWithGeoip = { ...settings, geoipAvailable: this._geoipAvailable(settings) };
    if (settings.bypassIran && !settingsWithGeoip.geoipAvailable) {
      this._log(
        settings.activeCore === 'singbox'
          ? '[signalray] هشدار: «عبور مستقیم ترافیک ایران» فعال است اما مسیر فایل geoip-ir.srs در تنظیمات مشخص نشده یا پیدا نشد؛ این قانون نادیده گرفته می‌شود.'
          : '[signalray] هشدار: «عبور مستقیم ترافیک ایران» فعال است اما مسیر فایل geoip.dat در تنظیمات مشخص نشده یا پیدا نشد؛ این قانون نادیده گرفته می‌شود.'
      );
    }

    const config =
      settings.activeCore === 'singbox' ? buildSingboxConfig(profile, settingsWithGeoip) : buildXrayConfig(profile, settingsWithGeoip);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalray-'));
    this.configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');

    const args = ['run', '-c', this.configPath];

    // Xray-core looks up geoip.dat/geosite.dat either next to the binary or
    // in the directory pointed to by XRAY_LOCATION_ASSET; setting this lets
    // the user keep those files anywhere and just pick the path in Settings.
    const spawnEnv = { ...process.env };
    if (settings.activeCore !== 'singbox' && settings.geoipDatPath) {
      spawnEnv.XRAY_LOCATION_ASSET = path.dirname(settings.geoipDatPath);
    }

    this._setStatus('connecting');
    this._log(`[signalray] در حال اجرای هسته: ${corePath} ${args.join(' ')}`);

    this.proc = spawn(corePath, args, { windowsHide: true, env: spawnEnv });
    this.currentProfileId = profile.id;
    this.startedAt = Date.now();

    this.proc.stdout.on('data', (d) => this._log(d.toString().trim()));
    this.proc.stderr.on('data', (d) => this._log(d.toString().trim()));

    this.proc.on('error', (err) => {
      this._log(`[signalray] خطا در اجرای هسته: ${err.message}`);
      this._setStatus('error', { error: err.message });
    });

    this.proc.on('close', (code) => {
      this._log(`[signalray] هسته متوقف شد (کد خروج: ${code})`);
      this.proc = null;
      this.startedAt = null;
      this._stopStatsPolling();
      if (this.status !== 'error') this._setStatus('disconnected');
      this._cleanupTmp(tmpDir);
    });

    this.corePath = corePath;
    this.activeCore = settings.activeCore;
    this.statsApiPort = settings.statsApiPort || 18888;
    this.trafficTotals = { uplink: 0, downlink: 0 };
    this._lastXrayStat = null;

    // Give the core a moment to bind its listeners, then confirm the local
    // SOCKS port is actually accepting connections before calling it "connected".
    const ok = await this._waitForLocalPort(settings.socksPort, 5000);
    if (ok) {
      this._setStatus('connected');
      if (settings.showLiveStats !== false) this._startStatsPolling();
    } else if (this.proc) {
      this._setStatus('error', { error: 'هسته اجرا شد اما پورت محلی SOCKS در دسترس نیست' });
    }

    return this.getStatus();
  }

  _waitForLocalPort(port, timeoutMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tryOnce = () => {
        const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
          socket.end();
          resolve(true);
        });
        socket.on('error', () => {
          socket.destroy();
          if (Date.now() > deadline || !this.proc) resolve(false);
          else setTimeout(tryOnce, 250);
        });
      };
      tryOnce();
    });
  }

  _cleanupTmp(tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      /* ignore */
    }
  }

  async stop() {
    this._stopStatsPolling();
    if (!this.proc) {
      this._setStatus('disconnected');
      return;
    }
    await new Promise((resolve) => {
      const p = this.proc;
      if (!p) return resolve();
      p.once('close', () => resolve());
      if (process.platform === 'win32') {
        // taskkill ensures the whole process tree (core + any helper) exits.
        spawn('taskkill', ['/pid', String(p.pid), '/f', '/t']).on('close', () => {});
      } else {
        p.kill('SIGTERM');
      }
      setTimeout(resolve, 2000);
    });
    this.proc = null;
    this.currentProfileId = null;
    this.startedAt = null;
    this._setStatus('disconnected');
  }

  // ---------- Real traffic stats ----------

  _startStatsPolling() {
    this._stopStatsPolling();
    if (this.activeCore === 'singbox') {
      this._startSingboxTrafficStream();
    } else {
      this._pollXrayStatsOnce();
      this.statsTimer = setInterval(() => this._pollXrayStatsOnce(), 1000);
    }
  }

  _stopStatsPolling() {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (this.statsRequest) {
      this.statsRequest.destroy();
      this.statsRequest = null;
    }
  }

  /** Uses Xray's own CLI (`xray api statsquery`) — no extra gRPC library needed. */
  _pollXrayStatsOnce() {
    if (!this.corePath || !this.statsApiPort) return;
    execFile(
      this.corePath,
      ['api', 'statsquery', `--server=127.0.0.1:${this.statsApiPort}`, '-pattern', 'outbound>>>proxy>>>traffic'],
      { windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        if (err || !stdout) return; // core may not be ready yet; skip this tick silently
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch (e) {
          return;
        }
        let uplink = 0;
        let downlink = 0;
        for (const stat of parsed.stat || []) {
          const value = Number(stat.value || 0);
          if (stat.name && stat.name.includes('>>>uplink')) uplink += value;
          else if (stat.name && stat.name.includes('>>>downlink')) downlink += value;
        }

        const now = Date.now();
        if (this._lastXrayStat) {
          const dt = Math.max(0.5, (now - this._lastXrayStat.time) / 1000);
          const upSpeed = Math.max(0, (uplink - this._lastXrayStat.uplink) / dt);
          const downSpeed = Math.max(0, (downlink - this._lastXrayStat.downlink) / dt);
          this.trafficTotals = { uplink, downlink };
          this.emit('traffic', { uploadBps: upSpeed, downloadBps: downSpeed, uplinkTotal: uplink, downlinkTotal: downlink });
        }
        this._lastXrayStat = { uplink, downlink, time: now };
      }
    );
  }

  /** sing-box exposes a Clash-compatible /traffic endpoint that streams live speed as NDJSON. */
  _startSingboxTrafficStream() {
    if (!this.statsApiPort) return;
    const attempt = () => {
      if (this.status !== 'connected') return;
      const req = http.get({ host: '127.0.0.1', port: this.statsApiPort, path: '/traffic', timeout: 0 }, (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            try {
              const obj = JSON.parse(line);
              const up = Number(obj.up || 0);
              const down = Number(obj.down || 0);
              this.trafficTotals.uplink += up;
              this.trafficTotals.downlink += down;
              this.emit('traffic', {
                uploadBps: up,
                downloadBps: down,
                uplinkTotal: this.trafficTotals.uplink,
                downlinkTotal: this.trafficTotals.downlink
              });
            } catch (e) {
              /* ignore malformed line */
            }
          }
        });
        res.on('close', () => {
          if (this.status === 'connected') setTimeout(attempt, 1000); // reconnect if the core restarted the API
        });
      });
      req.on('error', () => {
        if (this.status === 'connected') setTimeout(attempt, 1500);
      });
      this.statsRequest = req;
    };
    attempt();
  }

  /**
   * Measures raw TCP handshake latency straight to the proxy server's
   * address:port — no core process, no tunnel, just a TCP SYN/ACK timing.
   * Lets the user check a config's reachability/latency before connecting.
   */
  /** Multiple quick TCP-connect samples -> {ok, avgMs, jitterMs, lossPct}. Used for
   *  quality-aware server selection (not just a single, possibly-lucky ping). */
  async pingQuality(address, port, samples = 3, timeoutMs = 3000) {
    const results = [];
    for (let i = 0; i < samples; i++) results.push(await this.pingDirect(address, port, timeoutMs));
    const oks = results.filter((r) => r.ok);
    const lossPct = Math.round(((results.length - oks.length) / results.length) * 100);
    if (!oks.length) return { ok: false, lossPct: 100 };
    const avgMs = Math.round(oks.reduce((a, r) => a + r.ms, 0) / oks.length);
    let jitterMs = 0;
    for (let i = 1; i < oks.length; i++) jitterMs += Math.abs(oks[i].ms - oks[i - 1].ms);
    jitterMs = oks.length > 1 ? Math.round(jitterMs / (oks.length - 1)) : 0;
    return { ok: true, avgMs, jitterMs, lossPct };
  }

  pingDirect(address, port, timeoutMs = 6000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const socket = new net.Socket();
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish({ ok: true, ms: Date.now() - start }));
      socket.once('timeout', () => finish({ ok: false, error: 'timeout' }));
      socket.once('error', (err) => finish({ ok: false, error: err.message }));
      socket.connect(port, address);
    });
  }

  /**
   * Rough latency check performed through the local HTTP proxy: since the
   * core's HTTP inbound accepts absolute-URI GET requests for plain HTTP
   * targets without a CONNECT tunnel, this measures real round-trip time
   * through the tunnel to the remote server, not just to localhost.
   */
  pingThroughProxy(httpPort, targetUrl = 'http://www.gstatic.com/generate_204') {
    const http = require('http');
    return new Promise((resolve) => {
      const start = Date.now();
      const req = http.request(
        {
          host: '127.0.0.1',
          port: httpPort,
          path: targetUrl,
          method: 'GET',
          timeout: 8000
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve({ ok: true, ms: Date.now() - start, statusCode: res.statusCode }));
        }
      );
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, error: 'timeout' });
      });
      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      req.end();
    });
  }
}

module.exports = { CoreManager };
