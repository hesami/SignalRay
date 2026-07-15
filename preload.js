'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('signalray', {
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    close: () => ipcRenderer.send('win:close'),
    quit: () => ipcRenderer.send('win:quit')
  },
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    import: (text) => ipcRenderer.invoke('profiles:import', text),
    importWireguard: (text, remark) => ipcRenderer.invoke('profiles:importWireguard', { text, remark }),
    delete: (id) => ipcRenderer.invoke('profiles:delete', id),
    rename: (id, remark) => ipcRenderer.invoke('profiles:rename', { id, remark }),
    update: (id, fields) => ipcRenderer.invoke('profiles:update', { id, fields })
  },
  subscriptions: {
    list: () => ipcRenderer.invoke('subscriptions:list'),
    add: (url, remark) => ipcRenderer.invoke('subscriptions:add', { url, remark }),
    refresh: (id) => ipcRenderer.invoke('subscriptions:refresh', id),
    delete: (id) => ipcRenderer.invoke('subscriptions:delete', id)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (partial) => ipcRenderer.invoke('settings:save', partial),
    browseCore: (coreName) => ipcRenderer.invoke('settings:browseCore', coreName),
    browseGeoFile: (kind) => ipcRenderer.invoke('settings:browseGeoFile', kind),
    updateGeo: (activeCore) => ipcRenderer.invoke('settings:updateGeo', activeCore)
  },
  core: {
    status: () => ipcRenderer.invoke('core:status'),
    connect: (profileId) => ipcRenderer.invoke('core:connect', profileId),
    disconnect: () => ipcRenderer.invoke('core:disconnect'),
    ping: () => ipcRenderer.invoke('core:ping'),
    pingDirect: (profileId) => ipcRenderer.invoke('core:pingDirect', profileId),
    pingAll: () => ipcRenderer.invoke('core:pingAll'),
    speedTest: () => ipcRenderer.invoke('core:speedTest'),
    findBest: () => ipcRenderer.invoke('core:findBest'),
    resolveIp: (profileId) => ipcRenderer.invoke('core:resolveIp', profileId),
    onStatus: (cb) => ipcRenderer.on('core:status', (_e, payload) => cb(payload)),
    onLog: (cb) => ipcRenderer.on('core:log', (_e, line) => cb(line)),
    onTraffic: (cb) => ipcRenderer.on('core:traffic', (_e, payload) => cb(payload))
  },
  mtu: {
    find: (profileId) => ipcRenderer.invoke('mtu:find', profileId),
    onProgress: (cb) => ipcRenderer.on('mtu:progress', (_e, payload) => cb(payload))
  },
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url)
});
