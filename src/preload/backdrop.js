'use strict';

/**
 * 「挡板」窗口专用 preload。
 *
 * 面板打开时会在屏幕上铺一层全屏透明窗口（挡板），它只干一件事：
 * 用户在面板/悬浮球以外的地方按鼠标，就把这一下告诉主进程 → 收起面板。
 *
 * 为什么要这么绕：原来靠「窗口失焦」判断用户点了别处，但这台机器上
 * 面板弹出来经常拿不到焦点（Windows 前台权限问题），没有焦点就永远
 * 不会失焦 —— 于是「点外面关不掉」。挡板不依赖焦点，点哪都能接住。
 */
const { ipcRenderer } = require('electron');

function report(event) {
  try {
    ipcRenderer.send('backdrop:click', {
      button: event && typeof event.button === 'number' ? event.button : 0
    });
  } catch (_) {
    /* ignore */
  }
}

window.addEventListener('mousedown', report, true);
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  report(e);
});
