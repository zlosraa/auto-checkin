'use strict';

/**
 * preload.js — 渲染进程唯一的能力入口
 *
 * 渲染层没有 Node 权限（sandbox + contextIsolation），只能通过这里暴露的白名单方法
 * 与主进程通信。新增系统能力时在这里加一个方法 + 主进程加一个 handler。
 *
 * 注意：这里永远不返回完整 token / cookie / SendKey，
 * 敏感信息在主进程就被脱敏，前端拿不到可外泄的凭据。
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

/** 统一的订阅封装：返回取消订阅函数 */
function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const handler = (_event, payload) => {
    try {
      callback(payload);
    } catch (err) {
      console.error(`[${channel}] 回调异常`, err);
    }
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('toolbox', {
  /* ------------------------------------------------------------ 基础 */
  getBootstrap: () => invoke('app:get-bootstrap'),
  reloadConfig: () => invoke('app:reload-config'),
  diagnose: () => invoke('app:diagnose'),
  onConfigChanged: (cb) => subscribe('app:config-changed', cb),

  /* -------------------------------------------------------- 脚本工具 */
  runTool: (toolId) => invoke('tool:run', { toolId }),
  cancelRun: (runId) => invoke('tool:cancel', { runId }),
  listActiveRuns: () => invoke('tool:list-active'),
  saveTools: (tools) => invoke('tool:save-tools', { tools }),
  onRunEvent: (cb) => subscribe('app:run-event', cb),

  /* ------------------------------------------------------------ 对话框 */
  pickScript: () => invoke('dialog:pick-script'),
  pickDir: () => invoke('dialog:pick-dir'),
  confirm: (options) => invoke('dialog:confirm', options),

  /* -------------------------------------------------------- 路径/日志 */
  openConfigDir: () => invoke('shell:open-config-dir'),
  openPath: (p) => invoke('shell:open-path', { path: p }),
  revealPath: (p) => invoke('shell:reveal-path', { path: p }),
  openLogDir: () => invoke('shell:open-log-dir'),

  /* ------------------------------------------------------------ 签到 */
  checkin: {
    state: () => invoke('checkin:state'),
    sendCode: (payload) => invoke('checkin:send-code', payload),
    login: (payload) => invoke('checkin:login', payload),
    run: (payload) => invoke('checkin:run', payload),
    cancel: (runId) => invoke('checkin:cancel', { runId }),
    removeAccount: (payload) => invoke('checkin:remove-account', payload),
    saveSettings: (payload) => invoke('checkin:save-settings', payload),
    testNotify: () => invoke('checkin:test-notify'),
    clearAll: () => invoke('checkin:clear-all'),
    onEvent: (cb) => subscribe('checkin:event', cb),
  },
});
