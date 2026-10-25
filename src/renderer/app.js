'use strict';

/**
 * app.js — 前端外壳
 *
 * 职责仅限于「壳」：读模块清单 → 生成侧边导航 → 按需动态 import 模块入口 → 提供公共能力。
 * 这里不包含任何具体业务逻辑；新增功能 = 在 modules/ 下加一个目录，无需改动本文件。
 */

const ICONS = {
  bolt: '<path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13z"/>',
  calendar:
    '<rect x="3" y="4.5" width="18" height="16" rx="4"/><path d="M8 3v3M16 3v3M3 9.5h18"/><path d="m9 15 2 2 4-4.5"/>',
  gamepad:
    '<path d="M7.5 8h9a5.5 5.5 0 0 1 5.4 6.5l-.5 2.6A2.6 2.6 0 0 1 16 18.4L14 16h-4l-2 2.4a2.6 2.6 0 0 1-4.4-1.3l-.5-2.6A5.5 5.5 0 0 1 7.5 8z"/><path d="M8 11v3M6.5 12.5h3M15.5 12h.01M17.5 13.5h.01"/>',
  gear:
    '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.05A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.05A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3.05V3a2 2 0 1 1 4 0v.05A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.05a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.05a1.7 1.7 0 0 0-1.55 1z"/>',
  book: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 19.5V4.5"/><path d="M8 7h8M8 11h6"/>',
  square: '<rect x="3" y="3" width="18" height="18" rx="4"/>',
};

const els = {
  nav: document.getElementById('nav'),
  views: document.getElementById('views'),
  banners: document.getElementById('banners'),
  title: document.getElementById('view-title'),
  desc: document.getElementById('view-desc'),
  actions: document.getElementById('topbar-actions'),
  brandSub: document.getElementById('brand-sub'),
  configPath: document.getElementById('config-path'),
  toasts: document.getElementById('toasts'),
  btnReload: document.getElementById('btn-reload'),
  btnConfig: document.getElementById('btn-config'),
};

const state = {
  /** @type {any} */
  boot: null,
  activeId: null,
  /** id -> { manifest, view, root, module, ctx } */
  instances: new Map(),
};

/* ------------------------------------------------------------------ 小工具 */

function icon(name, cls) {
  const body = ICONS[name] || ICONS.square;
  return `<svg class="${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== undefined && value !== null && value !== false) {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** 全局轻提示 */
function toast(message, type = 'info', timeout = 3200) {
  const node = el('div', { class: `toast ${type}`, text: message });
  els.toasts.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s';
    setTimeout(() => node.remove(), 220);
  }, timeout);
}

function fmtTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m} 分 ${s} 秒`;
}

/** 把 ISO 时间显示成「今天 14:05 / 10-24 09:12」 */
function fmtWhen(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const hhmm = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (sameDay) return `今天 ${hhmm}`;
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${hhmm}`;
}

/* -------------------------------------------------------------- 头部/横幅 */

function setHeader({ title, description, actions }) {
  els.title.textContent = title || '签到工具箱';
  els.desc.textContent = description || '';
  els.actions.replaceChildren();
  for (const action of actions || []) {
    if (!action) continue;
    els.actions.appendChild(
      el('button', {
        class: `btn ${action.variant || ''}`.trim(),
        type: 'button',
        text: action.label,
        onClick: action.onClick,
        title: action.title || '',
      })
    );
  }
}

function renderBanners() {
  const warnings = state.boot?.warnings || [];
  els.banners.replaceChildren();
  if (!warnings.length) return;

  const list = el('ul', {}, warnings.slice(0, 8).map((w) => el('li', { text: w })));
  const more =
    warnings.length > 8 ? el('div', { class: 'muted', text: `…… 另有 ${warnings.length - 8} 条提示` }) : null;
  els.banners.appendChild(
    el('div', { class: 'banner warn' }, [
      el('div', {}, [
        el('b', { text: `配置检查发现 ${warnings.length} 处需要留意的问题（不影响其他工具使用）：` }),
        list,
        more,
      ]),
    ])
  );
}

function renderBrand() {
  const cfg = state.boot.config;
  const sourceLabel = {
    env: '环境变量指定',
    portable: 'exe 同级目录',
    exe: '程序目录',
    userdata: '用户数据目录',
    bundled: '内置只读配置',
  }[cfg.source] || cfg.source;

  els.brandSub.textContent = `${state.boot.app.version} · ${sourceLabel}`;
  els.configPath.textContent = cfg.dir;
  els.configPath.title = `${cfg.toolsFile}\n${cfg.modulesFile}`;
}

/* ------------------------------------------------------------------ 导航 */

function renderNav() {
  const modules = state.boot?.modules || [];
  els.nav.replaceChildren();

  for (const manifest of modules) {
    const btn = el('button', {
      class: 'nav-item',
      type: 'button',
      'data-nav-id': manifest.id,
      title: manifest.description || manifest.title,
      onClick: () => activate(manifest.id),
    });
    btn.innerHTML = `${icon(manifest.icon)}<span class="nav-item-text"></span>`;
    btn.querySelector('.nav-item-text').textContent = manifest.title;
    els.nav.appendChild(btn);
  }

  if (!modules.length) {
    els.nav.appendChild(
      el('div', {
        class: 'muted',
        style: 'padding:8px 10px;font-size:12px',
        text: '没有启用任何模块，请检查 modules.json。',
      })
    );
  }
  syncNavActive();
}

function syncNavActive() {
  for (const btn of els.nav.querySelectorAll('[data-nav-id]')) {
    btn.setAttribute('aria-current', String(btn.dataset.navId === state.activeId));
  }
}

/* -------------------------------------------------------- 模块加载与挂载 */

function injectModuleStyles(manifest) {
  const styles = Array.isArray(manifest.styles) ? manifest.styles : [];
  for (const href of styles) {
    const url = `/modules/${manifest.dir}/${href}`;
    if (document.querySelector(`link[data-module-style="${url}"]`)) continue;
    const link = el('link', { rel: 'stylesheet', href: url });
    link.dataset.moduleStyle = url;
    document.head.appendChild(link);
  }
}

function makeContext(manifest, view) {
  return {
    /** 启动数据（应用信息 / 配置 / 工具 / 模块 / 签到快照） */
    get boot() {
      return state.boot;
    },
    api: window.toolbox,
    module: manifest,
    /** 模块自己控制顶部标题与右侧按钮 */
    setHeader: (options) => {
      if (state.activeId === manifest.id) setHeader(options);
    },
    toast,
    fmtTime,
    fmtWhen,
    /** 模块内的 DOM 工具，避免各自重复实现 */
    el,
    icon,
  };
}

async function loadModule(manifest) {
  const view = el('div', { class: 'view', 'data-view-id': manifest.id, hidden: true });
  els.views.appendChild(view);

  const root = el('div', { class: 'module-root' });
  view.appendChild(root);

  const ctx = makeContext(manifest, view);
  const instance = { manifest, view, root, module: null, ctx, mounted: false };
  state.instances.set(manifest.id, instance);

  try {
    injectModuleStyles(manifest);
    const mod = await import(`/modules/${manifest.dir}/${manifest.entry}`);
    const impl = mod.default || mod;
    if (typeof impl.mount !== 'function') {
      throw new Error('模块必须 export default { async mount(root, ctx) {…} }');
    }
    instance.module = impl;
    await impl.mount(root, ctx);
    instance.mounted = true;
  } catch (err) {
    console.error(`[module:${manifest.id}] 加载失败`, err);
    view.replaceChildren(
      el('div', { class: 'module-error' }, [
        el('strong', { text: `模块「${manifest.title}」加载失败` }),
        el('pre', { text: String((err && err.stack) || err) }),
      ])
    );
    const navBtn = els.nav.querySelector(`[data-nav-id="${manifest.id}"]`);
    if (navBtn) navBtn.appendChild(el('span', { class: 'dot-warn' }));
    toast(`模块「${manifest.title}」加载失败，详情见界面提示`, 'error', 5000);
  }
  return instance;
}

async function activate(id) {
  const manifest = (state.boot?.modules || []).find((m) => m.id === id);
  if (!manifest) return;

  if (!state.instances.has(id)) {
    await loadModule(manifest);
  }
  state.activeId = id;
  for (const [instId, inst] of state.instances) {
    inst.view.hidden = instId !== id;
  }
  syncNavActive();

  // 标题/按钮交给模块自己决定；模块没设置就用清单里的默认值
  setHeader({ title: manifest.title, description: manifest.description, actions: [] });
  const inst = state.instances.get(id);
  if (inst?.module?.updateHeader) {
    try {
      await inst.module.updateHeader(inst.ctx);
    } catch (err) {
      console.error('[module header]', err);
    }
  }
  els.views.scrollTop = 0;
}

/* -------------------------------------------------- 配置热更新（无需重启） */

async function applyConfigChange(boot, reason) {
  const previousActive = state.activeId;
  state.boot = boot;
  renderBrand();
  renderBanners();

  const validIds = new Set((boot.modules || []).map((m) => m.id));

  // 被移除/禁用的模块：销毁实例
  for (const [id, inst] of [...state.instances]) {
    if (!validIds.has(id)) {
      try {
        await inst.module?.unmount?.();
      } catch {
        /* ignore */
      }
      inst.view.remove();
      state.instances.delete(id);
    }
  }

  renderNav();

  // 已挂载的模块：优先走 onConfigChanged，否则重建
  for (const [id, inst] of state.instances) {
    const latest = boot.modules.find((m) => m.id === id);
    if (!latest) continue;
    inst.manifest = latest;
    if (typeof inst.module?.onConfigChanged === 'function') {
      try {
        await inst.module.onConfigChanged(inst.ctx, boot);
        continue;
      } catch (err) {
        console.error(`[module:${id}] onConfigChanged 失败，改为重建`, err);
      }
    }
    try {
      await inst.module?.unmount?.();
    } catch {
      /* ignore */
    }
    inst.root.replaceChildren();
    try {
      await inst.module?.mount?.(inst.root, inst.ctx);
    } catch (err) {
      console.error(`[module:${id}] 重建失败`, err);
    }
  }

  if (previousActive && validIds.has(previousActive)) {
    await activate(previousActive);
  } else if (boot.modules?.length) {
    await activate(boot.modules[0].id);
  }

  if (reason) toast(reason, 'success');
}

/* ------------------------------------------------------------------ 启动 */

async function start() {
  if (!window.toolbox) {
    els.views.appendChild(
      el('div', { class: 'module-error' }, [
        el('strong', { text: '未检测到桌面运行环境' }),
        el('pre', { text: '请通过 Electron 启动本程序（npm start），而不是直接用浏览器打开 index.html。' }),
      ])
    );
    return;
  }

  try {
    state.boot = await window.toolbox.getBootstrap();
  } catch (err) {
    els.views.appendChild(
      el('div', { class: 'module-error' }, [
        el('strong', { text: '读取配置失败' }),
        el('pre', { text: String((err && err.message) || err) }),
      ])
    );
    return;
  }

  renderBrand();
  renderNav();
  renderBanners();

  const modules = state.boot.modules || [];
  if (modules.length) await activate(modules[0].id);

  window.toolbox.onConfigChanged((payload) => {
    if (payload?.boot) applyConfigChange(payload.boot, payload.reason || '配置已更新');
  });

  // 供自动化测试/调试探测
  window.__toolboxReady = {
    modules: modules.length,
    tools: (state.boot.tools || []).length,
    accounts: {
      skland: state.boot.checkin?.accounts?.skland?.length || 0,
      miyoushe: state.boot.checkin?.accounts?.miyoushe?.length || 0,
    },
    active: state.activeId,
    configDir: state.boot.config.dir,
  };
}

els.btnReload.addEventListener('click', async () => {
  els.btnReload.disabled = true;
  try {
    const res = await window.toolbox.reloadConfig();
    if (res?.boot) await applyConfigChange(res.boot, res.message);
  } catch (err) {
    toast(`重新加载失败：${err.message}`, 'error');
  } finally {
    els.btnReload.disabled = false;
  }
});

els.btnConfig.addEventListener('click', async () => {
  const res = await window.toolbox.openConfigDir();
  if (res && res.ok === false) toast(`打开配置目录失败：${res.error}`, 'error');
});

start();
