'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('api', {
  // ---- 共用 ----
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (cb) => subscribe('state:update', cb),
  platform: process.platform,

  // ---- 悬浮球 ----
  ballInteractive: (isOver) => ipcRenderer.send('ball:interactive', !!isOver),
  ballDrag: (payload) => ipcRenderer.send('ball:drag', payload),
  ballClick: () => ipcRenderer.send('ball:click'),
  ballMenu: () => ipcRenderer.send('ball:menu'),
  onReminder: (cb) => subscribe('reminder:fire', cb),
  onBallHover: (cb) => subscribe('ball:set-hover', cb),

  // ---- 面板 ----
  hidePanel: () => ipcRenderer.send('panel:hide'),
  panelReady: () => ipcRenderer.send('panel:ready'),
  openPanel: () => ipcRenderer.send('panel:open'),
  onPanelShown: (cb) => subscribe('panel:shown', cb),

  // ---- 待办 ----
  addTodo: (input) => ipcRenderer.invoke('todos:add', input),
  updateTodo: (id, patch) => ipcRenderer.invoke('todos:update', { id, patch }),
  toggleTodo: (id) => ipcRenderer.invoke('todos:toggle', id),
  removeTodo: (id) => ipcRenderer.invoke('todos:remove', id),
  restoreTodo: (todo) => ipcRenderer.invoke('todos:restore', todo),
  clearCompleted: () => ipcRenderer.invoke('todos:clearCompleted'),

  // ---- 设置 / 系统 ----
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
  exportJson: () => ipcRenderer.invoke('app:exportJson'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('app:setAutoLaunch', !!enabled),
  copyText: (text) => ipcRenderer.invoke('app:copyText', text),

  // ---- 学习通（内置同步） ----
  cxSync: () => ipcRenderer.invoke('chaoxing:sync'),
  cxLogin: (target) => ipcRenderer.invoke('chaoxing:login', target),
  cxLogout: () => ipcRenderer.invoke('chaoxing:logout'),

  quit: () => ipcRenderer.send('app:quit')
});
