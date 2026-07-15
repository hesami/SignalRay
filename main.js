'use strict';

const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const { Store } = require('./src/store');
const { parseUri, parseBulk } = require('./src/profileParser');
const { CoreManager } = require('./src/coreManager');
const systemProxy = require('./src/systemProxy');
const systemDns = require('./src/systemDns');
const { updateGeoFiles } = require('./src/geoDownloader');
const { findOptimalMtu } = require('./src/mtuFinder');
const { resolveServerIp } = require('./src/serverIpResolver');
const { fetchSubscription } = require('./src/subscriptionFetcher');
const { runSpeedTest } = require('./src/speedTest');
const { parseWireGuardConf } = require('./src/profileParser');

let mainWindow = null;
let tray = null;
let store = null;
const core = new CoreManager();

const APP_ICON_PATH = path.join(__dirname, 'renderer', 'assets', 'icon.ico');
const TRAY_ICONS = {
  disconnected: path.join(__dirname, 'renderer', 'assets', 'tray-disconnected.png'),
  connecting: path.join(__dirname, 'renderer', 'assets', 'tray-connecting.png'),
  connected: path.join(__dirname, 'renderer', 'assets', 'tray-connected.png'),
  error: path.join(__dirname, 'renderer', 'assets', 'tray-error.png')
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 820,
    minWidth: 360,
    minHeight: 680,
    backgroundColor: '#0b0e14',
    frame: false,
    show: false,
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setAspectRatio(420 / 820);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  core.on('status', (payload) => {
    if (mainWindow) mainWindow.webContents.send('core:status', payload);
    updateTray(payload.status);
  });
  core.on('log', (line) => {
    if (mainWindow) mainWindow.webContents.send('core:log', line);
  });
  core.on('traffic', (payload) => {
    if (mainWindow) mainWindow.webContents.send('core:traffic', payload);
    trackUsageForPersistence(payload);
  });
}

// ---------- Per-config usage persistence (throttled — not on every tick) ----------
let usageTrackingProfileId = null;
let usageLastTotals = { uplink: 0, downlink: 0 };
let usagePendingDelta = { upload: 0, download: 0 };
let usageFlushTimer = null;

function resetUsageTracking(profileId) {
  usageTrackingProfileId = profileId;
  usageLastTotals = { uplink: 0, downlink: 0 };
  usagePendingDelta = { upload: 0, download: 0 };
}

function trackUsageForPersistence(payload) {
  if (!usageTrackingProfileId) return;
  const deltaUp = Math.max(0, (payload.uplinkTotal || 0) - usageLastTotals.uplink);
  const deltaDown = Math.max(0, (payload.downlinkTotal || 0) - usageLastTotals.downlink);
  usagePendingDelta.upload += deltaUp;
  usagePendingDelta.download += deltaDown;
  usageLastTotals = { uplink: payload.uplinkTotal || 0, downlink: payload.downlinkTotal || 0 };

  if (!usageFlushTimer) {
    usageFlushTimer = setTimeout(flushUsageToStore, 10000); // batch writes every 10s
  }
}

function flushUsageToStore() {
  usageFlushTimer = null;
  if (!usageTrackingProfileId || (!usagePendingDelta.upload && !usagePendingDelta.download)) return;
  store.addProfileUsage(usageTrackingProfileId, usagePendingDelta.upload, usagePendingDelta.download);
  usagePendingDelta = { upload: 0, download: 0 };
}

function updateTray(status) {
  if (!tray) return;
  const iconPath = TRAY_ICONS[status] || TRAY_ICONS.disconnected;
  tray.setImage(nativeImage.createFromPath(iconPath));
  const statusLabel = { disconnected: 'غیرفعال', connecting: 'در حال اتصال…', connected: 'متصل', error: 'خطا' }[status] || status;
  tray.setToolTip(`SignalRay — ${statusLabel}`);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(TRAY_ICONS.disconnected));
  tray.setToolTip('SignalRay — غیرفعال');
  const menu = Menu.buildFromTemplate([
    { label: 'نمایش پنجره', click: () => mainWindow && mainWindow.show() },
    { type: 'separator' },
    {
      label: 'قطع اتصال و خروج',
      click: async () => {
        app.isQuitting = true;
        flushUsageToStore();
        try {
          await core.stop();
          if (store.getSettings().autoSystemProxy) await systemProxy.disableSystemProxy().catch(() => {});
          if (store.getSettings().dnsThroughTunnel !== false) await systemDns.disableSystemDns().catch(() => {});
        } finally {
          app.quit();
        }
      }
    }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => mainWindow && mainWindow.show());
}

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  // keep running in tray; real quit happens via tray menu
});

app.on('before-quit', () => {
  app.isQuitting = true;
  flushUsageToStore();
});

// ---------- IPC: window controls ----------
ipcMain.on('win:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('win:close', () => mainWindow && mainWindow.hide());
ipcMain.on('win:quit', async () => {
  app.isQuitting = true;
  flushUsageToStore();
  try {
    await core.stop();
    if (store.getSettings().autoSystemProxy) await systemProxy.disableSystemProxy().catch(() => {});
    if (store.getSettings().dnsThroughTunnel !== false) await systemDns.disableSystemDns().catch(() => {});
  } finally {
    app.quit();
  }
});

// ---------- IPC: profiles ----------
ipcMain.handle('profiles:list', () => store.getProfiles());

ipcMain.handle('profiles:import', (_e, text) => {
  const { profiles, errors } = parseBulk(text);
  if (profiles.length) store.addProfiles(profiles);
  return { added: profiles.length, profiles: store.getProfiles(), errors };
});

ipcMain.handle('profiles:delete', (_e, id) => store.deleteProfile(id));

ipcMain.handle('profiles:rename', (_e, { id, remark }) => store.updateProfile(id, { remark }));

ipcMain.handle('profiles:update', (_e, { id, fields }) => store.updateProfile(id, fields));

// ---------- IPC: subscriptions ----------
ipcMain.handle('subscriptions:list', () => store.getSubscriptions());

ipcMain.handle('subscriptions:add', async (_e, { url, remark }) => {
  const { profiles, errors, userinfo } = await fetchSubscription(url);
  const subId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const taggedProfiles = profiles.map((p) => ({ ...p, subscriptionId: subId }));
  store.addSubscription({
    id: subId,
    url,
    remark: remark || new URL(url).hostname,
    userinfo: userinfo || null,
    addedAt: Date.now(),
    lastFetched: Date.now()
  });
  if (taggedProfiles.length) store.addProfiles(taggedProfiles);
  return {
    subscriptions: store.getSubscriptions(),
    profiles: store.getProfiles(),
    added: taggedProfiles.length,
    errors
  };
});

ipcMain.handle('subscriptions:refresh', async (_e, subId) => {
  const sub = store.getSubscriptions().find((s) => s.id === subId);
  if (!sub) throw new Error('این سابسکریپشن یافت نشد');
  const { profiles, errors, userinfo } = await fetchSubscription(sub.url);
  const taggedProfiles = profiles.map((p) => ({ ...p, subscriptionId: subId }));
  store.replaceSubscriptionProfiles(subId, taggedProfiles);
  store.updateSubscription(subId, { userinfo: userinfo || sub.userinfo || null, lastFetched: Date.now() });
  return {
    subscriptions: store.getSubscriptions(),
    profiles: store.getProfiles(),
    added: taggedProfiles.length,
    errors
  };
});

ipcMain.handle('subscriptions:delete', (_e, subId) => store.deleteSubscription(subId));

// ---------- IPC: settings ----------
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:save', (_e, partial) => store.saveSettings(partial));

ipcMain.handle('settings:browseCore', async (_e, coreName) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: coreName === 'singbox' ? 'انتخاب فایل اجرایی sing-box' : 'انتخاب فایل اجرایی Xray-core',
    properties: ['openFile'],
    filters: process.platform === 'win32' ? [{ name: 'Executable', extensions: ['exe'] }] : []
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// ---------- IPC: connection ----------
ipcMain.handle('core:status', () => core.getStatus());

ipcMain.handle('core:connect', async (_e, profileId) => {
  const settings = store.getSettings();
  const profile = store.getProfiles().find((p) => p.id === profileId);
  if (!profile) throw new Error('پروفایل انتخاب‌شده یافت نشد');

  const status = await core.start(profile, settings);
  store.setLastActiveProfile(profile.id);
  resetUsageTracking(profile.id);

  if (settings.autoSystemProxy && status.status === 'connected') {
    try {
      await systemProxy.enableSystemProxy(settings.httpPort);
    } catch (err) {
      core._log(`[signalray] هشدار: تنظیم پروکسی سیستم ناموفق بود: ${err.message}`);
    }
  }
  if (settings.dnsThroughTunnel !== false && status.status === 'connected') {
    try {
      await systemDns.enableSystemDns();
    } catch (err) {
      core._log(`[signalray] هشدار: تنظیم DNS سیستم ناموفق بود: ${err.message}`);
    }
  }
  return status;
});

ipcMain.handle('core:disconnect', async () => {
  const settings = store.getSettings();
  await core.stop();
  flushUsageToStore();
  usageTrackingProfileId = null;
  if (settings.autoSystemProxy) {
    await systemProxy.disableSystemProxy().catch(() => {});
  }
  if (settings.dnsThroughTunnel !== false) {
    await systemDns.disableSystemDns().catch(() => {});
  }
  return core.getStatus();
});

ipcMain.handle('core:ping', async () => {
  const settings = store.getSettings();
  return core.pingThroughProxy(settings.httpPort);
});

ipcMain.handle('core:pingDirect', async (_e, profileId) => {
  const profile = store.getProfiles().find((p) => p.id === profileId);
  if (!profile) throw new Error('پروفایل انتخاب‌شده یافت نشد');
  return core.pingDirect(profile.address, profile.port);
});

ipcMain.handle('core:pingAll', async () => {
  const profiles = store.getProfiles();
  const results = {};
  const CONCURRENCY = 5;
  let idx = 0;
  async function worker() {
    while (idx < profiles.length) {
      const profile = profiles[idx++];
      results[profile.id] = await core.pingDirect(profile.address, profile.port, 4000);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, profiles.length) }, worker));
  return results;
});

ipcMain.handle('core:resolveIp', async (_e, profileId) => {
  const profile = store.getProfiles().find((p) => p.id === profileId);
  if (!profile) throw new Error('پروفایل انتخاب‌شده یافت نشد');
  return resolveServerIp(profile.address);
});

ipcMain.handle('core:speedTest', async () => {
  const settings = store.getSettings();
  if (core.status !== 'connected') throw new Error('برای تست سرعت باید ابتدا متصل باشید');
  return runSpeedTest(settings.httpPort);
});

ipcMain.handle('core:findBest', async () => {
  const profiles = store.getProfiles();
  if (!profiles.length) throw new Error('هیچ کانفیگی وجود ندارد');
  const results = {};
  const CONCURRENCY = 5;
  let idx = 0;
  async function worker() {
    while (idx < profiles.length) {
      const profile = profiles[idx++];
      results[profile.id] = await core.pingDirect(profile.address, profile.port, 4000);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, profiles.length) }, worker));

  let bestId = null;
  let bestMs = Infinity;
  for (const [id, res] of Object.entries(results)) {
    if (res.ok && res.ms < bestMs) {
      bestMs = res.ms;
      bestId = id;
    }
  }
  if (!bestId) throw new Error('هیچ کانفیگی پاسخ نداد');
  return { bestId, bestMs, results };
});

// ---------- IPC: WireGuard config import ----------
ipcMain.handle('profiles:importWireguard', (_e, { text, remark }) => {
  try {
    const profile = parseWireGuardConf(text, remark);
    store.addProfiles([profile]);
    return { added: 1, profiles: store.getProfiles(), errors: [] };
  } catch (e) {
    return { added: 0, profiles: store.getProfiles(), errors: [{ line: '[WireGuard .conf]', error: e.message }] };
  }
});

// ---------- IPC: MTU optimizer ----------
ipcMain.handle('mtu:find', async (_e, profileId) => {
  const profile = store.getProfiles().find((p) => p.id === profileId);
  if (!profile) throw new Error('پروفایل انتخاب‌شده یافت نشد');
  const result = await findOptimalMtu(profile.address, (size) => {
    if (mainWindow) mainWindow.webContents.send('mtu:progress', { size });
  });
  return result;
});

// ---------- IPC: geo data files ----------
ipcMain.handle('settings:browseGeoFile', async (_e, kind) => {
  const filters =
    kind === 'singboxGeoipIrPath'
      ? [{ name: 'sing-box rule-set', extensions: ['srs'] }]
      : [{ name: 'Xray geo data', extensions: ['dat'] }];
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'انتخاب فایل داده جغرافیایی',
    properties: ['openFile'],
    filters
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('settings:updateGeo', async (_e, activeCore) => {
  mainWindow.webContents.send('core:log', `[signalray] در حال دانلود فایل‌های Geo برای ${activeCore === 'singbox' ? 'sing-box' : 'Xray-core'}…`);
  const { updatedPaths, errors } = await updateGeoFiles(app.getPath('userData'), activeCore);
  const settings = store.saveSettings(updatedPaths);
  for (const key of Object.keys(updatedPaths)) {
    mainWindow.webContents.send('core:log', `[signalray] بروزرسانی شد: ${updatedPaths[key]}`);
  }
  for (const err of errors) {
    mainWindow.webContents.send('core:log', `[signalray] خطا در بروزرسانی: ${err}`);
  }
  return { settings, updatedPaths, errors };
});

ipcMain.handle('shell:openExternal', (_e, url) => shell.openExternal(url));
