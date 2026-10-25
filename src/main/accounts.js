'use strict';

/**
 * accounts.js — 账号与设置的数据仓库
 *
 * 上层（IPC / 签到业务）只跟这个模块打交道，它负责：
 *  · 统一的数据结构（森空岛账号 / 米游社账号 / 推送设置）
 *  · 敏感字段脱敏后再交给渲染进程（前端永远拿不到完整 token）
 *  · 增删改查都落盘到 secure-store 的加密文件里
 */

const crypto = require('node:crypto');

const KINDS = ['skland', 'miyoushe'];

const DEFAULT_SETTINGS = {
  serverChan: {
    enabled: true,
    sendKey: '',
    notifyOn: 'always', // always | failure | never
  },
};

function emptyVault() {
  return {
    version: 1,
    skland: { accounts: [] },
    miyoushe: { accounts: [] },
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
  };
}

/** 把任意来源的数据补齐成完整结构（旧版本 / 手改坏了的文件也能兜住） */
function normalizeVault(raw) {
  const vault = emptyVault();
  if (!raw || typeof raw !== 'object') return vault;

  for (const kind of KINDS) {
    const section = raw[kind];
    const list = section && Array.isArray(section.accounts) ? section.accounts : [];
    vault[kind].accounts = list
      .filter((item) => item && typeof item === 'object' && item.id)
      .map((item) => ({ ...item }));
  }

  const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const sc = settings.serverChan && typeof settings.serverChan === 'object' ? settings.serverChan : {};
  vault.settings.serverChan = {
    enabled: sc.enabled !== false,
    sendKey: typeof sc.sendKey === 'string' ? sc.sendKey : '',
    notifyOn: ['always', 'failure', 'never'].includes(sc.notifyOn) ? sc.notifyOn : 'always',
  };
  return vault;
}

/* ------------------------------------------------------------------ 脱敏 */

function maskPhone(phone) {
  const value = String(phone || '');
  if (!/^\d{11}$/.test(value)) return value || '—';
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function maskSecret(secret) {
  const value = String(secret || '');
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-2)}`;
}

/* ------------------------------------------------------- 公开视图（脱敏） */

function publicAccount(kind, account) {
  const base = {
    id: account.id,
    name: account.name || '未命名账号',
    phoneMasked: maskPhone(account.phone),
    createdAt: account.createdAt || null,
    lastLoginAt: account.lastLoginAt || null,
    lastRunAt: account.lastRunAt || null,
    lastRunStatus: account.lastRunStatus || null,
  };
  if (kind === 'skland') {
    return {
      ...base,
      boards: Array.isArray(account.boards) && account.boards.length
        ? account.boards
        : ['arknights', 'endfield'],
      uid: account.uid || '',
      nickName: account.nickName || '',
      tokenMasked: maskSecret(account.token),
      hasCredential: !!account.token,
    };
  }
  return {
    ...base,
    uid: account.uid || '',
    mid: account.mid || '',
    boards: Array.isArray(account.boards) && account.boards.length ? account.boards : ['sr', 'zzz'],
    stokenMasked: maskSecret(account.stoken),
    hasCredential: !!account.stoken,
  };
}

/**
 * @param {object} options
 * @param {ReturnType<import('./secure-store').createSecureStore>} options.secure
 */
function createAccountStore({ secure }) {
  let vault = null;

  function ensureLoaded() {
    if (vault) return vault;
    vault = normalizeVault(secure.load());
    return vault;
  }

  function persist() {
    const data = ensureLoaded();
    const res = secure.save(data);
    if (!res.ok) {
      console.error('[accounts] 保存失败：', res.error);
    }
    return res;
  }

  function section(kind) {
    if (!KINDS.includes(kind)) throw new Error(`未知的账号类型：${kind}`);
    return ensureLoaded()[kind];
  }

  /* ---------------------------------------------------------- 账号读写 */

  function list(kind) {
    return section(kind).accounts.map((account) => publicAccount(kind, account));
  }

  function all(kind) {
    return section(kind).accounts.map((account) => ({ ...account }));
  }

  function get(kind, id) {
    const found = section(kind).accounts.find((a) => a.id === id);
    return found ? { ...found } : null;
  }

  /**
   * 新增或按手机号覆盖已有账号。返回 { ok, account, action }
   * credential 里的敏感字段直接整段替换（登录成功才会调用）。
   */
  function upsert(kind, payload) {
    if (!KINDS.includes(kind)) return { ok: false, error: `未知的账号类型：${kind}` };
    const data = section(kind);
    const phone = String(payload.phone || '').trim();
    const name = String(payload.name || '').trim();

    let target = phone ? data.accounts.find((a) => String(a.phone || '') === phone) : null;
    if (!target && payload.id) target = data.accounts.find((a) => a.id === payload.id);

    const now = new Date().toISOString();
    if (target) {
      Object.assign(target, payload, {
        id: target.id,
        name: name || target.name,
        phone: phone || target.phone,
        createdAt: target.createdAt || now,
        lastLoginAt: now,
      });
      const saved = persist();
      return saved.ok
        ? { ok: true, account: { ...target }, action: 'updated' }
        : { ok: false, error: saved.error };
    }

    const account = {
      ...payload,
      id: crypto.randomUUID(),
      name: name || (data.accounts.length ? `账号 ${data.accounts.length + 1}` : '主账号'),
      phone,
      createdAt: now,
      lastLoginAt: now,
    };
    data.accounts.push(account);
    const saved = persist();
    if (!saved.ok) {
      data.accounts.pop();
      return { ok: false, error: saved.error };
    }
    return { ok: true, account: { ...account }, action: 'created' };
  }

  function remove(kind, id) {
    const data = section(kind);
    const index = data.accounts.findIndex((a) => a.id === id);
    if (index === -1) return { ok: false, error: '账号不存在（可能已被删除）' };
    const [removed] = data.accounts.splice(index, 1);
    const saved = persist();
    if (!saved.ok) {
      data.accounts.splice(index, 0, removed);
      return { ok: false, error: saved.error };
    }
    return { ok: true, name: removed.name };
  }

  /** 签到结束后记录一下时间与状态；凭据续期也会用到 */
  function patch(kind, id, changes) {
    const data = section(kind);
    const target = data.accounts.find((a) => a.id === id);
    if (!target) return { ok: false, error: '账号不存在' };
    Object.assign(target, changes);
    const saved = persist();
    return saved.ok ? { ok: true, account: { ...target } } : { ok: false, error: saved.error };
  }

  /* ------------------------------------------------------------ 设置 */

  function getServerChan() {
    return { ...ensureLoaded().settings.serverChan };
  }

  function publicSettings() {
    const sc = getServerChan();
    return {
      serverChan: {
        enabled: sc.enabled,
        notifyOn: sc.notifyOn,
        hasKey: !!sc.sendKey,
        keyMasked: maskSecret(sc.sendKey),
      },
    };
  }

  function saveServerChan(input, options = {}) {
    const data = ensureLoaded();
    const current = data.settings.serverChan;
    const next = { ...current };

    if (typeof input.enabled === 'boolean') next.enabled = input.enabled;
    if (typeof input.notifyOn === 'string' && ['always', 'failure', 'never'].includes(input.notifyOn)) {
      next.notifyOn = input.notifyOn;
    }
    // 只在前端明确提交了新 key 时替换；传空字符串表示「清空」
    if (typeof input.sendKey === 'string' && !options.keepKey) {
      next.sendKey = input.sendKey.trim();
    }

    data.settings.serverChan = next;
    const saved = persist();
    if (!saved.ok) {
      data.settings.serverChan = current;
      return { ok: false, error: saved.error };
    }
    return { ok: true, settings: publicSettings() };
  }

  /** 清空全部凭据与设置（危险操作，界面会二次确认） */
  function clearAll() {
    vault = emptyVault();
    const removed = secure.remove();
    if (!removed.ok) return { ok: false, error: removed.error };
    const saved = persist();
    return saved.ok ? { ok: true } : { ok: false, error: saved.error };
  }

  function describe() {
    const data = ensureLoaded();
    const info = secure.describe();
    return {
      ...info,
      counts: {
        skland: data.skland.accounts.length,
        miyoushe: data.miyoushe.accounts.length,
      },
    };
  }

  return {
    list,
    all,
    get,
    upsert,
    remove,
    patch,
    getServerChan,
    publicSettings,
    saveServerChan,
    clearAll,
    describe,
  };
}

module.exports = {
  createAccountStore,
  maskPhone,
  maskSecret,
  DEFAULT_SETTINGS,
  KINDS,
};
