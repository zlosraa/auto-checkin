'use strict';

/**
 * http.js — 签到业务用到的轻量 HTTP 封装
 *
 * 用 Node 内置 fetch（Electron 33 / Node 20+ 自带，自动解 gzip），原因：
 *  · 不引第三方依赖，打包体积与供应链风险都为 0
 *  · 统一处理超时（AbortController）、重试、JSON 解析与中文错误文案
 */

const DEFAULT_TIMEOUT_MS = 25000;

/** 可预期的业务错误：消息直接可以给用户看 */
class CheckinError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'CheckinError';
    this.stage = options.stage || '';
  }
}

/** 需要人机验证（滑块），程序无法自动完成 */
class CaptchaRequired extends CheckinError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'CaptchaRequired';
  }
}

/** 凭据彻底失效，本轮可以提前结束 */
class CredentialExpired extends CheckinError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'CredentialExpired';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 发一个请求。
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {Record<string,string>} [options.headers]
 * @param {any} [options.json]       作为 JSON body 提交
 * @param {Record<string,any>} [options.form] 作为 x-www-form-urlencoded 提交
 * @param {number} [options.timeoutMs]
 * @param {number} [options.retries] 网络错误/5xx 时的重试次数
 * @param {number} [options.retryBaseMs]
 * @param {string} [options.label]   出错时给人看的操作名，例如「发送验证码」
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{status:number, ok:boolean, headers:Headers, text:string, json:any}>}
 */
async function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    json,
    form,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 2,
    retryBaseMs = 1200,
    label = '网络请求',
    signal: externalSignal,
  } = options;

  const finalHeaders = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    ...headers,
  };

  let body;
  if (json !== undefined) {
    body = JSON.stringify(json);
    finalHeaders['content-type'] = 'application/json; charset=utf-8';
  } else if (form !== undefined) {
    body = new URLSearchParams(form).toString();
    finalHeaders['content-type'] = 'application/x-www-form-urlencoded; charset=utf-8';
  } else if (method !== 'GET' && method !== 'HEAD') {
    body = '';
  }

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(retryBaseMs * attempt * (0.85 + Math.random() * 0.3));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const response = await fetch(url, {
        method,
        headers: finalHeaders,
        body,
        redirect: 'follow',
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      const result = {
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        text,
        json: parsed,
      };
      // 5xx 才值得重试；4xx 是业务问题，重试没意义
      if (response.status >= 500 && attempt < retries) {
        lastError = new CheckinError(`${label}失败：服务器返回 ${response.status}`, {});
        continue;
      }
      return result;
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
      if (externalSignal && externalSignal.aborted) {
        lastError = new CheckinError('操作已被取消');
      } else if (aborted) {
        lastError = new CheckinError(`${label}超时（${Math.round(timeoutMs / 1000)} 秒无响应），请检查网络或代理设置。`);
      } else {
        lastError = new CheckinError(
          `${label}失败：无法连接服务器（${(err && err.message) || '未知网络错误'}）。请检查网络、代理或防火墙设置。`
        );
      }
      if (attempt >= retries) break;
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener?.('abort', onAbort);
    }
  }
  throw lastError || new CheckinError(`${label}失败：未知原因`);
}

/** 要求返回 JSON，否则给出可读错误 */
async function requestJson(url, options = {}) {
  const res = await request(url, options);
  if (!res.json) {
    const snippet = (res.text || '').slice(0, 160).replace(/\s+/g, ' ');
    throw new CheckinError(
      `${options.label || '请求'}返回的内容无法解析为 JSON（HTTP ${res.status}）：${snippet || '空响应'}`
    );
  }
  return res;
}

/** 取接口里的错误文案：有的叫 message、有的叫 msg */
function errorText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return String(payload.message || payload.msg || payload.error || '').trim();
}

/** 生成大写 UUID（米游社设备号格式） */
function deviceId() {
  return require('node:crypto').randomUUID().toUpperCase();
}

module.exports = {
  request,
  requestJson,
  errorText,
  deviceId,
  sleep,
  CheckinError,
  CaptchaRequired,
  CredentialExpired,
  DEFAULT_TIMEOUT_MS,
};
