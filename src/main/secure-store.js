'use strict';

/**
 * secure-store.js — 本地加密存储（敏感信息只在这里落盘）
 *
 * 为什么需要它：签到凭据（token / cookie / stoken）与 Server酱 SendKey 都属于
 * 「拿到就能冒充你」的敏感数据。项目将来可能开源，所以：
 *   · 绝不写进 config/*.json（那是给别人看的示例配置）
 *   · 绝不硬编码在源码里
 *   · 落盘前用系统级密钥加密：Windows 上是 DPAPI（Electron safeStorage），
 *     密文只能被「当前 Windows 用户的当前登录会话之外的人」解不开；
 *     把文件拷到别的机器 / 别的账户下也解不开。
 *
 * 文件布局：<userData>/secure/vault.bin
 *   内容 = base64( safeStorage.encryptString( JSON 字符串 ) )
 *
 * 依赖注入 safeStorage，方便在没有 Electron 的环境里跑单测。
 */

const fs = require('node:fs');
const path = require('node:path');

const VAULT_FILE = 'vault.bin';

/**
 * @param {object} options
 * @param {string} options.dir        存放目录（一般是 app.getPath('userData')/secure）
 * @param {object} options.safeStorage Electron 的 safeStorage（需实现 isEncryptionAvailable / encryptString / decryptString）
 */
function createSecureStore({ dir, safeStorage }) {
  const file = path.join(dir, VAULT_FILE);
  let cache = null;
  let lastError = null;

  function encryptionAvailable() {
    try {
      return !!safeStorage && safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /** Electron 在 Windows 上提供的是 DPAPI；给界面展示用 */
  function backendName() {
    if (!encryptionAvailable()) return '不可用';
    try {
      if (typeof safeStorage.getSelectedStorageBackend === 'function') {
        return `OS 加密（${safeStorage.getSelectedStorageBackend() || 'safeStorage'}）`;
      }
    } catch {
      /* 旧版本没有这个方法 */
    }
    return process.platform === 'win32' ? 'Windows DPAPI（safeStorage）' : 'OS 加密（safeStorage）';
  }

  /** 读取解密后的对象；文件不存在返回 null；解不开返回 null 并记录原因 */
  function load() {
    if (cache) return cache;
    if (!fs.existsSync(file)) return null;
    if (!encryptionAvailable()) {
      lastError = '当前系统不支持加密存储，已保存的凭据无法读取（换机器 / 换 Windows 账户后会这样）。';
      return null;
    }
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (!raw) return null;
      const buf = Buffer.from(raw, 'base64');
      const plain = safeStorage.decryptString(buf);
      const parsed = JSON.parse(plain);
      cache = parsed && typeof parsed === 'object' ? parsed : null;
      return cache;
    } catch (err) {
      lastError =
        '凭据文件无法解密（可能更换了 Windows 账户，或文件损坏）。请在「设置与诊断」里清空凭据后重新登录。';
      console.warn('[secure-store] 解密失败：', err.message);
      return null;
    }
  }

  /**
   * 覆盖写入。写临时文件再 rename，避免掉电/崩溃把已有凭据写坏；
   * 旧文件先备份成 vault.bin.bak。
   */
  function save(data) {
    if (!encryptionAvailable()) {
      return {
        ok: false,
        error:
          '系统未提供可用的加密能力，出于安全考虑不会以明文保存凭据。请使用 Windows 桌面环境运行本程序。',
      };
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      const plain = JSON.stringify(data);
      const cipher = safeStorage.encryptString(plain);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, Buffer.from(cipher).toString('base64'), 'utf8');
      if (fs.existsSync(file)) {
        try {
          fs.copyFileSync(file, `${file}.bak`);
        } catch {
          /* 备份失败不阻断保存 */
        }
      }
      fs.renameSync(tmp, file);
      cache = data;
      lastError = null;
      return { ok: true, file };
    } catch (err) {
      return { ok: false, error: `保存凭据失败：${err.code || err.message}` };
    }
  }

  function exists() {
    return fs.existsSync(file);
  }

  function remove() {
    cache = null;
    try {
      for (const target of [file, `${file}.bak`, `${file}.tmp`]) {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `删除凭据文件失败：${err.code || err.message}` };
    }
  }

  function describe() {
    return {
      available: encryptionAvailable(),
      backend: backendName(),
      file,
      dir,
      exists: exists(),
      error: lastError,
    };
  }

  return { load, save, exists, remove, describe, encryptionAvailable, file };
}

module.exports = { createSecureStore, VAULT_FILE };
