'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  corePathXray: '',
  corePathSingbox: '',
  activeCore: 'xray', // 'xray' | 'singbox'
  socksPort: 10808,
  httpPort: 10809,
  statsApiPort: 18888,
  logLevel: 'warning',
  bypassLAN: true,
  bypassIran: false,
  dnsThroughTunnel: true,
  autoSystemProxy: true,
  theme: 'dark',
  fontScale: 1.1,
  geoipDatPath: '',
  geositeDatPath: '',
  singboxGeoipIrPath: '',
  enableFragment: false,
  enableMux: false,
  muxConcurrency: 8,
  enableTcpFastOpen: true,
  mtu: 0,
  dnsServers: '1.1.1.1,1.0.0.1',
  domainStrategy: 'IPIfNonMatch',
  defaultFingerprint: 'chrome',
  periodicHealthCheck: false,
  periodicHealthCheckIntervalSec: 30,
  autoSelectBest: false,
  showLiveStats: true
};

class Store {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.file = path.join(userDataDir, 'signalray-data.json');
    this.data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        const parsed = JSON.parse(raw);
        return {
          settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
          profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
          subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
          lastActiveProfileId: parsed.lastActiveProfileId || null
        };
      }
    } catch (e) {
      console.error('Failed to load store, starting fresh:', e);
    }
    return { settings: { ...DEFAULT_SETTINGS }, profiles: [], subscriptions: [], lastActiveProfileId: null };
  }

  _save() {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      console.error('Failed to save store:', e);
    }
  }

  getSettings() {
    return this.data.settings;
  }

  saveSettings(partial) {
    this.data.settings = { ...this.data.settings, ...partial };
    this._save();
    return this.data.settings;
  }

  getProfiles() {
    return this.data.profiles;
  }

  addProfiles(profiles) {
    this.data.profiles.push(...profiles);
    this._save();
    return this.data.profiles;
  }

  updateProfile(id, partial) {
    const idx = this.data.profiles.findIndex((p) => p.id === id);
    if (idx !== -1) {
      this.data.profiles[idx] = { ...this.data.profiles[idx], ...partial };
      this._save();
    }
    return this.data.profiles;
  }

  /** Accumulates real traffic (bytes) attributable to a specific config, persisted across sessions. */
  addProfileUsage(id, deltaUpload, deltaDownload) {
    const idx = this.data.profiles.findIndex((p) => p.id === id);
    if (idx === -1) return this.data.profiles;
    const p = this.data.profiles[idx];
    p.usageUpload = (p.usageUpload || 0) + Math.max(0, deltaUpload || 0);
    p.usageDownload = (p.usageDownload || 0) + Math.max(0, deltaDownload || 0);
    this._save();
    return this.data.profiles;
  }

  deleteProfile(id) {
    this.data.profiles = this.data.profiles.filter((p) => p.id !== id);
    this._save();
    return this.data.profiles;
  }

  setLastActiveProfile(id) {
    this.data.lastActiveProfileId = id;
    this._save();
  }

  getLastActiveProfile() {
    return this.data.lastActiveProfileId;
  }

  // ---------- Subscriptions ----------
  getSubscriptions() {
    return this.data.subscriptions;
  }

  addSubscription(sub) {
    this.data.subscriptions.push(sub);
    this._save();
    return this.data.subscriptions;
  }

  updateSubscription(id, partial) {
    const idx = this.data.subscriptions.findIndex((s) => s.id === id);
    if (idx !== -1) {
      this.data.subscriptions[idx] = { ...this.data.subscriptions[idx], ...partial };
      this._save();
    }
    return this.data.subscriptions;
  }

  deleteSubscription(id) {
    this.data.subscriptions = this.data.subscriptions.filter((s) => s.id !== id);
    this.data.profiles = this.data.profiles.filter((p) => p.subscriptionId !== id);
    this._save();
    return { subscriptions: this.data.subscriptions, profiles: this.data.profiles };
  }

  /** Replaces all profiles belonging to a subscription with a fresh set (used on refresh). */
  replaceSubscriptionProfiles(subscriptionId, newProfiles) {
    this.data.profiles = this.data.profiles.filter((p) => p.subscriptionId !== subscriptionId);
    this.data.profiles.push(...newProfiles);
    this._save();
    return this.data.profiles;
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
