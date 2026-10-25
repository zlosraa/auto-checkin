'use strict';

/**
 * main.js — Electron 主进程
 *
 * 只做「外壳 + 受控能力」这两件事：
 *   · 开窗、托管前端静态资源（自定义协议，不是 file://）、菜单、单实例、崩溃兜底
 *   · 把渲染进程的调用转成受控的系统操作：跑脚本、读写配置、加密存凭据、签到、推送
 * 具体签到协议在 checkin/ 目录，脚本执行在 runner.js，都不依赖 electron，可单独测试。
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const runner = require('./runner');
const store = require('./config-store');
const { createSecureStore } = require('./secure-store');
const { createAccountStore } = require('./accounts');
const { createCheckinService, KIND_META } = require('./checkin');

const IS_SMOKE = process.argv.includes('--smoke-test');
const APP_ROOT = path.join(__dirname, '..', '..');
const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');
const MODULES_ROOT = path.join(RENDERER_ROOT, 'modules');
const SCHEME = 'autocheckin';

/** @type {BrowserWindow | null} */
let mainWindow = null;

/** 内存中的配置快照 */
const state = {
  configDir: '',
  configSource: 'bundled',
  configWritable: false,
  bundledDir: '',
  config: { tools: [], rawTools: [], modules: {}, warnings: [], toolsModifiedAt: null },
  modules: [],
  moduleWarnings: [],
};

/** 加密存储 / 账号仓库 / 签到服务（app ready 后初始化） */
let secureStore = null;
let accountStore = null;
let checkinService = null;

// ------------------------------------------------------------------ 单实例

const gotLock = IS_SMOKE ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ------------------------------------------------------------------ 协议注册

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function registerProtocol() {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      let pathname = decodeURIComponent(url.pathname || '/');
      if (pathname === '/' || pathname === '') pathname = '/index.html';

      const resolved = path.normalize(path.join(RENDERER_ROOT, pathname));
      // 目录穿越防护：只允许读取 renderer 目录内的文件
      if (resolved !== RENDERER_ROOT && !resolved.startsWith(RENDERER_ROOT + path.sep)) {
        return new Response('Forbidden', { status: 403 });
      }
      const data = await fs.promises.readFile(resolved);
      const type = MIME_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
      return new Response(data, { status: 200, headers: { 'content-type': type } });
    } catch (err) {
      const status = err && err.code === 'ENOENT' ? 404 : 500;
      return new Response(`Resource error: ${err.code || err.message}`, { status });
    }
  });
}

// ------------------------------------------------------------------ 目录定位

/** 打包后配置随 extraResources 放在 resources/config */
function bundledConfigDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'config') : path.join(APP_ROOT, 'config');
}

/** 相对路径的兜底基准：开发态是项目根目录，打包后是 resources */
function fallbackRoots() {
  return app.isPackaged ? [process.resourcesPath] : [APP_ROOT];
}

function userDataDir(...parts) {
  return path.join(app.getPath('userData'), ...parts);
}

/**
 * 配置目录优先级：
 *   1. 环境变量 AUTOCHECKIN_CONFIG_DIR（企业内统一分发配置用）
 *   2. portable exe 同级目录下的 config（配置跟着 exe 走）
 *   3. 已安装程序 exe 同级目录下的 config
 *   4. 用户数据目录 config（首次运行从内置默认配置复制，始终可写）—— 默认
 *   5. 内置只读配置（兜底）
 */
function resolveConfigDir() {
  const bundledDir = bundledConfigDir();
  const candidates = [];
  if (process.env.AUTOCHECKIN_CONFIG_DIR || process.env.TOOLBOX_CONFIG_DIR) {
    candidates.push({
      dir: path.resolve(process.env.AUTOCHECKIN_CONFIG_DIR || process.env.TOOLBOX_CONFIG_DIR),
      source: 'env',
    });
  }
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    candidates.push({
      dir: path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'config'),
      source: 'portable',
    });
  }
  if (app.isPackaged) {
    candidates.push({ dir: path.join(path.dirname(app.getPath('exe')), 'config'), source: 'exe' });
  }

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate.dir, store.TOOLS_FILE))) {
      return { ...candidate, writable: isWritableDir(candidate.dir) };
    }
  }

  const userDir = userDataDir('config');
  const seeded = store.seedConfigDir(bundledDir, userDir);
  if (fs.existsSync(userDir)) {
    return { dir: userDir, source: 'userdata', writable: isWritableDir(userDir), seeded };
  }
  return { dir: bundledDir, source: 'bundled', writable: false, seeded: [] };
}

function isWritableDir(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ 状态装配

function reloadState(options = {}) {
  const location = options.relocate ? resolveConfigDir() : null;
  if (location) {
    state.configDir = location.dir;
    state.configSource = location.source;
    state.configWritable = location.writable;
    state.bundledDir = location.bundledDir || state.bundledDir;
    if (location.seeded && location.seeded.length && !IS_SMOKE) {
      console.log(`[config] 已从内置配置初始化用户配置：${location.seeded.join(', ')}`);
    }
  }

  const loaded = store.loadConfig(state.configDir, { fallbackRoots: fallbackRoots() });
  const scanned = store.scanModules(MODULES_ROOT);
  const resolved = store.resolveModules(scanned.manifests, loaded.modules);

  state.config = loaded;
  state.modules = resolved.modules;
  state.moduleWarnings = [...scanned.warnings, ...resolved.warnings];
  return state;
}

/** 敏感信息只以脱敏形式进入渲染层 */
function checkinSnapshot() {
  if (!accountStore) return { accounts: { skland: [], miyoushe: [] }, settings: {}, security: {} };
  return {
    accounts: {
      skland: accountStore.list('skland'),
      miyoushe: accountStore.list('miyoushe'),
    },
    settings: accountStore.publicSettings(),
    security: accountStore.describe(),
    running: {
      skland: checkinService?.isRunning('skland') || false,
      miyoushe: checkinService?.isRunning('miyoushe') || false,
    },
  };
}

function buildBootstrapPayload() {
  return {
    app: {
      name: '签到工具箱',
      version: app.getVersion(),
      packaged: app.isPackaged,
      env: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
      },
    },
    config: {
      dir: state.configDir,
      source: state.configSource,
      writable: state.configWritable,
      toolsFile: path.join(state.configDir, store.TOOLS_FILE),
      modulesFile: path.join(state.configDir, store.MODULES_FILE),
      toolsModifiedAt: state.config.toolsModifiedAt || null,
    },
    tools: state.config.tools,
    rawTools: state.config.rawTools,
    modules: state.modules,
    warnings: [...(state.config.warnings || []), ...state.moduleWarnings],
    checkin: checkinSnapshot(),
  };
}

/** 每次执行前比对 mtime，配置文件改了立即生效，无需重启 */
function ensureFreshConfig() {
  const toolsPath = path.join(state.configDir, store.TOOLS_FILE);
  let mtime = null;
  try {
    mtime = fs.statSync(toolsPath).mtimeMs;
  } catch {
    mtime = null;
  }
  if (mtime !== (state.config.toolsModifiedAt || null)) {
    reloadState();
    notifyConfigChanged('文件已被修改，配置已自动重新加载');
    return true;
  }
  return false;
}

function notifyConfigChanged(reason) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:config-changed', { reason, boot: buildBootstrapPayload() });
  }
}

function notifyCheckinEvent(event) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('checkin:event', event);
  }
}

// ------------------------------------------------------------------ 运行记录落盘

function logRun(summary) {
  try {
    const dir = userDataDir('logs');
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date(summary.startedAt || Date.now()).toISOString().slice(0, 10);
    const file = path.join(dir, `runs-${day}.jsonl`);
    fs.appendFileSync(
      file,
      JSON.stringify({
        runId: summary.runId,
        toolId: summary.toolId,
        name: summary.name,
        status: summary.status,
        exitCode: summary.exitCode,
        durationMs: summary.durationMs,
        timedOut: summary.timedOut,
        cancelled: summary.cancelled,
        errorMessage: summary.errorMessage,
        scriptPath: summary.scriptPath,
        cwd: summary.cwd,
        startedAt: new Date(summary.startedAt).toISOString(),
        stdoutTail: (summary.stdout || '').slice(-4000),
        stderrTail: (summary.stderr || '').slice(-4000),
      }) + '\n',
      'utf8'
    );
  } catch {
    /* 日志失败不影响主流程 */
  }
}

// ------------------------------------------------------------------ IPC

function registerIpc() {
  ipcMain.handle('app:get-bootstrap', () => buildBootstrapPayload());

  ipcMain.handle('app:reload-config', () => {
    reloadState({ relocate: true });
    return {
      ok: true,
      boot: buildBootstrapPayload(),
      message: `配置已重新加载（${state.config.tools.length} 个脚本工具，${state.modules.length} 个模块）`,
    };
  });

  // ---------------- 脚本工具

  ipcMain.handle('tool:run', async (event, payload = {}) => {
    const toolId = String(payload.toolId || '');
    ensureFreshConfig();

    const tool = state.config.tools.find((t) => t.id === toolId);
    if (!tool) {
      return { ok: false, error: `找不到工具 "${toolId}"，请检查 tools.json 或点击左下角「重新加载配置」。` };
    }
    if (!tool.ready) {
      return { ok: false, error: tool.problems[0] || '该工具配置有误，暂时无法运行。', problems: tool.problems };
    }
    if (runner.isToolRunning(toolId)) {
      return { ok: false, error: `「${tool.name}」正在运行中，请等待当前任务结束。` };
    }

    const runId = crypto.randomUUID();
    const sender = event.sender;
    const send = (evt) => {
      if (sender.isDestroyed()) return;
      try {
        sender.send('app:run-event', evt);
      } catch {
        /* 窗口已关闭 */
      }
    };

    runner
      .runTool(tool, { runId, onEvent: send })
      .then((summary) => logRun(summary))
      .catch((err) => {
        send({
          runId,
          toolId,
          type: 'exit',
          status: 'error',
          errorMessage: `执行过程发生未预期错误：${err.message}`,
          stdout: '',
          stderr: '',
          exitCode: null,
          durationMs: 0,
        });
      });

    return { ok: true, runId, tool };
  });

  ipcMain.handle('tool:cancel', (event, payload = {}) => {
    const cancelled = runner.cancelRun(String(payload.runId || ''));
    return { ok: cancelled, error: cancelled ? null : '该任务已结束或不存在。' };
  });

  ipcMain.handle('tool:list-active', () => ({ ok: true, runs: runner.listActiveRuns() }));

  /** 界面里增删改脚本按钮：写回 tools.json 并立即重载 */
  ipcMain.handle('tool:save-tools', (event, payload = {}) => {
    if (!state.configWritable) {
      return {
        ok: false,
        error: `当前配置目录是只读的（${state.configDir}），请改「%APPDATA%\\AutoCheckin\\config\\tools.json」或把 config 放到 exe 同级目录。`,
      };
    }
    const saved = store.saveTools(state.configDir, payload.tools);
    if (!saved.ok) return saved;
    reloadState();
    notifyConfigChanged('工具配置已保存');
    return {
      ok: true,
      message: `已保存 ${saved.count} 个脚本工具${saved.backup ? '（原文件备份为 tools.json.bak）' : ''}`,
      boot: buildBootstrapPayload(),
    };
  });

  // ---------------- 文件对话框

  ipcMain.handle('dialog:pick-script', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择要运行的批处理脚本',
      properties: ['openFile'],
      filters: [
        { name: '批处理脚本', extensions: ['bat', 'cmd'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: res.filePaths[0] };
  });

  ipcMain.handle('dialog:pick-dir', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择工作目录',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: res.filePaths[0] };
  });

  ipcMain.handle('dialog:confirm', async (event, payload = {}) => {
    const res = await dialog.showMessageBox(mainWindow, {
      type: payload.danger ? 'warning' : 'question',
      title: String(payload.title || '请确认'),
      message: String(payload.message || '确认执行该操作？'),
      detail: payload.detail ? String(payload.detail) : '',
      buttons: [String(payload.cancelLabel || '取消'), String(payload.confirmLabel || '确认')],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    return { ok: res.response === 1 };
  });

  // ---------------- 路径操作

  ipcMain.handle('shell:open-config-dir', async () => {
    const error = await shell.openPath(state.configDir);
    return error ? { ok: false, error } : { ok: true, dir: state.configDir };
  });

  ipcMain.handle('shell:open-path', async (event, payload = {}) => {
    const target = String(payload.path || '');
    if (!target) return { ok: false, error: '路径为空' };
    const error = await shell.openPath(target);
    return error ? { ok: false, error: `无法打开：${error}` } : { ok: true };
  });

  ipcMain.handle('shell:reveal-path', (event, payload = {}) => {
    const target = String(payload.path || '');
    if (!target) return { ok: false, error: '路径为空' };
    if (!fs.existsSync(target)) return { ok: false, error: `路径不存在：${target}` };
    shell.showItemInFolder(target);
    return { ok: true };
  });

  ipcMain.handle('shell:open-log-dir', async () => {
    const dir = userDataDir('logs');
    fs.mkdirSync(dir, { recursive: true });
    const error = await shell.openPath(dir);
    return error ? { ok: false, error } : { ok: true, dir };
  });

  ipcMain.handle('app:diagnose', () => {
    const items = state.config.tools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      scriptPath: tool.scriptPath,
      cwd: tool.cwd,
      scriptExists: !!tool.scriptPath && fs.existsSync(tool.scriptPath),
      cwdExists: !tool.cwd || fs.existsSync(tool.cwd),
      timeoutMs: tool.timeoutMs,
      running: runner.isToolRunning(tool.id),
      problems: tool.problems || [],
    }));
    return {
      ok: true,
      items,
      logDir: userDataDir('logs'),
      configDir: state.configDir,
      configWritable: state.configWritable,
      security: accountStore ? accountStore.describe() : null,
    };
  });

  // ---------------- 签到

  ipcMain.handle('checkin:state', () => {
    ensureFreshConfigIfNeeded();
    return { ok: true, ...checkinSnapshot() };
  });

  ipcMain.handle('checkin:send-code', async (event, payload = {}) => {
    const kind = String(payload.kind || '');
    if (!KIND_META[kind]) return { ok: false, error: '未知的签到类型' };
    return checkinService.sendCode(kind, payload.phone);
  });

  ipcMain.handle('checkin:login', async (event, payload = {}) => {
    const kind = String(payload.kind || '');
    if (!KIND_META[kind]) return { ok: false, error: '未知的签到类型' };
    const res = await checkinService.login(kind, {
      phone: payload.phone,
      code: payload.code,
      name: payload.name,
      deviceId: payload.deviceId,
    });
    return { ...res, state: checkinSnapshot() };
  });

  ipcMain.handle('checkin:run', (event, payload = {}) => {
    const kind = String(payload.kind || '');
    if (!KIND_META[kind]) return { ok: false, error: '未知的签到类型' };
    const result = checkinService.startRun(kind, {
      accountIds: Array.isArray(payload.accountIds) ? payload.accountIds.map(String) : [],
      onEvent: notifyCheckinEvent,
    });
    return result;
  });

  ipcMain.handle('checkin:cancel', (event, payload = {}) => checkinService.cancel(String(payload.runId || '')));

  ipcMain.handle('checkin:remove-account', (event, payload = {}) => {
    const kind = String(payload.kind || '');
    if (!KIND_META[kind]) return { ok: false, error: '未知的签到类型' };
    const res = accountStore.remove(kind, String(payload.id || ''));
    return { ...res, state: checkinSnapshot() };
  });

  ipcMain.handle('checkin:save-settings', (event, payload = {}) => {
    const input = payload.serverChan && typeof payload.serverChan === 'object' ? payload.serverChan : {};
    const res = accountStore.saveServerChan(input, { keepKey: input.keepKey === true });
    return { ...res, state: checkinSnapshot() };
  });

  ipcMain.handle('checkin:test-notify', () => checkinService.testNotify());

  ipcMain.handle('checkin:clear-all', () => {
    const res = accountStore.clearAll();
    return { ...res, state: checkinSnapshot() };
  });
}

/** 签到页刷新状态时也顺手比对一下 tools.json（避免用户改了文件看不到） */
function ensureFreshConfigIfNeeded() {
  try {
    ensureFreshConfig();
  } catch {
    /* 配置读取失败不应影响签到页 */
  }
}

// ------------------------------------------------------------------ 窗口

function createWindow() {
  const iconCandidates = [
    path.join(process.resourcesPath || '', 'icon.ico'),
    path.join(APP_ROOT, 'build', 'icon.ico'),
  ];
  const iconPath = iconCandidates.find((p) => p && fs.existsSync(p));

  mainWindow = new BrowserWindow({
    width: 1260,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#f5f7fb',
    title: '签到工具箱',
    autoHideMenuBar: false,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!IS_SMOKE) mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[renderer gone]', details);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (details.reason !== 'clean-exit') mainWindow.reload();
  });

  mainWindow.webContents.on('did-fail-load', (event, code, description, url) => {
    console.error('[did-fail-load]', code, description, url);
  });

  mainWindow.loadURL(`${SCHEME}://app/index.html`);

  if (IS_SMOKE) {
    mainWindow.webContents.on('console-message', (event, level, message) => {
      console.log(`[renderer:${level}] ${message}`);
    });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${SCHEME}://`)) {
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开配置目录',
          accelerator: 'CmdOrCtrl+O',
          click: () => shell.openPath(state.configDir),
        },
        {
          label: '重新加载配置',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            reloadState({ relocate: true });
            notifyConfigChanged('手动重新加载配置');
          },
        },
        { type: 'separator' },
        { label: '退出', accelerator: 'Alt+F4', role: 'quit' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '刷新界面', role: 'reload' },
        { label: '开发者工具', accelerator: 'F12', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开运行日志目录',
          click: () => {
            const dir = userDataDir('logs');
            fs.mkdirSync(dir, { recursive: true });
            shell.openPath(dir);
          },
        },
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: '关于',
              message: '签到工具箱',
              detail:
                `版本 ${app.getVersion()}\n` +
                `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}\n` +
                `配置目录：${state.configDir}\n` +
                `凭据存储：${accountStore ? accountStore.describe().file : '—'}`,
              buttons: ['确定'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------------ 冒烟测试

async function runSmokeTest() {
  const timeout = setTimeout(() => {
    console.error('[smoke] 超时：界面 20 秒内未就绪');
    app.exit(2);
  }, 20000);

  const shotIndex = process.argv.indexOf('--screenshot');
  const shotTarget = shotIndex !== -1 ? process.argv[shotIndex + 1] : null;
  if (shotTarget) mainWindow.showInactive();

  try {
    for (let i = 0; i < 60; i++) {
      const ready = await mainWindow.webContents.executeJavaScript('window.__toolboxReady || null', true);
      if (ready) {
        clearTimeout(timeout);
        console.log('[smoke] OK ' + JSON.stringify(ready));
        const probe = await mainWindow.webContents.executeJavaScript(
          `(() => {
             const cards = document.querySelectorAll('[data-tool-card]').length;
             const navs = document.querySelectorAll('[data-nav-id]').length;
             return { cards, navs, title: document.title, withError: document.querySelectorAll('.module-error').length };
           })()`,
          true
        );
        console.log('[smoke] DOM ' + JSON.stringify(probe));

        if (shotTarget) {
          const pageArg = process.argv.indexOf('--smoke-page');
          const only = pageArg !== -1 ? process.argv[pageArg + 1] : null;
          const ids = only
            ? [only]
            : ['bat-runner', 'skland', 'miyoushe', 'settings', 'welcome'];
          for (const id of ids) {
            const ok = await mainWindow.webContents.executeJavaScript(
              `(() => { const b = document.querySelector('[data-nav-id="${id}"]'); if (!b) return false; b.click(); return true; })()`,
              true
            );
            if (!ok) continue;
            await new Promise((r) => setTimeout(r, 700));
            const image = await mainWindow.webContents.capturePage();
            const file = path.isAbsolute(shotTarget) ? shotTarget : path.join(APP_ROOT, shotTarget);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(`${file}-${id}.png`, image.toPNG());
            console.log(`[smoke] 截图 ${file}-${id}.png`);
          }

          // 调试用：--smoke-click "选择器" 点击任意元素后截图（用于截取弹窗等交互态）
          const clickIndex = process.argv.indexOf('--smoke-click');
          if (clickIndex !== -1) {
            const selector = process.argv[clickIndex + 1] || '';
            const ok = await mainWindow.webContents.executeJavaScript(
              `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
              true
            );
            console.log(`[smoke] 点击 ${selector} -> ${ok}`);
            if (ok) {
              await new Promise((r) => setTimeout(r, 900));
              const image = await mainWindow.webContents.capturePage();
              const file = path.isAbsolute(shotTarget) ? shotTarget : path.join(APP_ROOT, shotTarget);
              fs.mkdirSync(path.dirname(file), { recursive: true });
              fs.writeFileSync(`${file}-click.png`, image.toPNG());
              console.log(`[smoke] 截图 ${file}-click.png`);
            }
          }

          // 调试用：点一下当前页的主按钮（运行脚本 / 一键签到），把执行中的状态截下来
          if (process.argv.includes('--smoke-run')) {
            const clicked = await mainWindow.webContents.executeJavaScript(
              `(() => {
                 const btn = document.querySelector('.view:not([hidden]) .ck-summary-actions .btn.primary, .view:not([hidden]) .tool-card .btn.primary');
                 if (!btn) return false;
                 btn.click();
                 return true;
               })()`,
              true
            );
            if (clicked) {
              await new Promise((r) => setTimeout(r, 7000));
              const probe2 = await mainWindow.webContents.executeJavaScript(
                `(() => {
                   const pill = document.querySelector('.log-head .pill');
                   const body = document.querySelector('.log-body');
                   return { pill: pill && pill.textContent, logLen: body ? (body.innerText || '').length : -1, preview: body ? (body.innerText || '').slice(0, 300) : '' };
                 })()`,
                true
              );
              console.log('[smoke] 运行后 ' + JSON.stringify(probe2));
              const image = await mainWindow.webContents.capturePage();
              const file = path.isAbsolute(shotTarget) ? shotTarget : path.join(APP_ROOT, shotTarget);
              fs.mkdirSync(path.dirname(file), { recursive: true });
              fs.writeFileSync(`${file}-running.png`, image.toPNG());
              console.log(`[smoke] 截图 ${file}-running.png`);
            }
          }
        }

        const passed = ready.modules > 0 && probe.navs > 0 && probe.withError === 0;
        app.exit(passed ? 0 : 3);
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    clearTimeout(timeout);
    console.error('[smoke] 界面未在预期时间内暴露 __toolboxReady');
    app.exit(2);
  } catch (err) {
    clearTimeout(timeout);
    console.error('[smoke] 失败：' + err.message);
    app.exit(2);
  }
}

// ------------------------------------------------------------------ 生命周期

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  try {
    dialog.showErrorBox('程序遇到一个未处理的错误', String(err && err.stack ? err.stack : err));
  } catch {
    /* ignore */
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', async (event) => {
  const count = runner.listActiveRuns().length;
  const checkinCount = checkinService ? checkinService.listRuns().length : 0;
  if (count > 0 || checkinCount > 0) {
    event.preventDefault();
    console.log(`[exit] 正在结束 ${count} 个运行中的脚本、${checkinCount} 个签到任务…`);
    checkinService?.cancelAll();
    await runner.cancelAll();
    setTimeout(() => app.exit(0), 300);
  }
});

app.whenReady().then(async () => {
  // 加密存储 → 账号仓库 → 签到服务
  secureStore = createSecureStore({ dir: userDataDir('secure'), safeStorage: require('electron').safeStorage });
  accountStore = createAccountStore({ secure: secureStore });
  checkinService = createCheckinService({ accounts: accountStore, logDir: userDataDir('logs') });

  registerProtocol();
  reloadState({ relocate: true });
  console.log(
    `[config] ${state.configDir}（${state.configSource}，${state.configWritable ? '可写' : '只读'}）` +
      ` · ${state.config.tools.length} 个工具 · ${state.modules.length} 个模块`
  );
  const security = accountStore.describe();
  console.log(
    `[secure] ${security.available ? security.backend : '加密不可用'} · ${security.file}` +
      ` · 森空岛 ${security.counts.skland} 个账号 / 米游社 ${security.counts.miyoushe} 个账号`
  );

  registerIpc();
  buildMenu();
  createWindow();

  if (IS_SMOKE) {
    await runSmokeTest();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
