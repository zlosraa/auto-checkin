'use strict';

/**
 * notify.js — Server酱（Turbo / Server酱³）微信推送
 *
 * SendKey 只从加密存储里读，绝不写进配置文件或日志。
 * 兼容两种地址：sctp 开头的 Server酱³ Key 需要 uid 子域名，其余走 sctapi。
 */

const { requestJson, errorText, CheckinError } = require('./http');

const MAX_TITLE = 32;

function serverChanUrls(sendKey) {
  const key = String(sendKey || '').trim();
  const urls = [];
  const match = /^sctp(\d+)t/.exec(key);
  if (match) urls.push(`https://${match[1]}.push.ft07.com/send/${key}.send`);
  urls.push(`https://sctapi.ftqq.com/${key}.send`);
  return urls;
}

/** 脱敏展示用：sctp123456txxxx → sctp1234••••xxxx */
function maskKey(key) {
  const value = String(key || '');
  if (value.length <= 10) return value ? '••••' : '';
  return `${value.slice(0, 8)}••••${value.slice(-4)}`;
}

/** 标题超长会被服务端截断，这里主动压一下 */
function clampTitle(title) {
  const text = String(title || '').replace(/[\r\n]+/g, ' ').trim();
  return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1)}…` : text;
}

/**
 * 发送一条 Markdown 推送。
 * @returns {Promise<{host:string, pushid:string}>}
 */
async function sendServerChan(sendKey, title, desp, options = {}) {
  const key = String(sendKey || '').trim();
  if (!key) throw new CheckinError('尚未配置 Server酱 SendKey，无法推送。');

  let lastError = '';
  for (const url of serverChanUrls(key)) {
    try {
      const res = await requestJson(url, {
        method: 'POST',
        form: { title: clampTitle(title), desp: desp || '' },
        retries: 1,
        timeoutMs: 15000,
        label: '微信推送',
        signal: options.signal,
      });
      const payload = res.json || {};
      const inner = payload.data && typeof payload.data === 'object' ? payload.data : {};
      if (payload.code === 0 || inner.errno === 0) {
        return { host: new URL(url).host, pushid: String(inner.pushid || '') };
      }
      lastError = errorText(payload) || `未知错误（code=${payload.code}）`;
    } catch (err) {
      lastError = err.message;
    }
  }
  throw new CheckinError(`微信推送失败：${lastError || '未知错误'}`);
}

/** 把签到结果整理成一条适合在微信里读的 Markdown */
function buildDigest({ label, results, failures, startedAt, durationMs }) {
  const icon = { success: '✅', already: '✅', fail: '❌', skip: '➖' };
  const success = results.filter((r) => r.status === 'success').length;
  const already = results.filter((r) => r.status === 'already').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const skip = results.filter((r) => r.status === 'skip').length;

  const title =
    fail > 0
      ? `${label}签到：成功 ${success} · 失败 ${fail}`
      : `${label}签到完成：成功 ${success}${already ? ` · 已签 ${already}` : ''}`;

  const lines = [];
  lines.push(`**结果**：成功 ${success} · 已签到 ${already} · 失败 ${fail} · 跳过 ${skip}`);
  lines.push('');
  for (const item of results) {
    const who = item.role && item.role !== '-' ? `${item.board} · ${item.role}` : item.board;
    lines.push(`- ${icon[item.status] || '•'} ${who}${item.detail ? `：${item.detail}` : ''}`);
  }
  lines.push('');
  if (Number.isFinite(durationMs)) {
    lines.push(`耗时：${(durationMs / 1000).toFixed(1)} 秒`);
  }
  lines.push(`时间：${new Date(startedAt || Date.now()).toLocaleString('zh-CN', { hour12: false })}`);
  lines.push('');
  lines.push('_由「签到工具箱」自动发送_');

  return {
    title,
    desp: lines.join('\n'),
    counts: { success, already, fail, skip, failures },
  };
}

module.exports = { sendServerChan, buildDigest, maskKey, serverChanUrls, clampTitle };
