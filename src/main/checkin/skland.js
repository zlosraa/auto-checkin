'use strict';

/**
 * skland.js — 森空岛（明日方舟 / 明日方舟：终末地）登录与签到
 *
 * 由 skland-checkin/skland_checkin.py 移植到 Node，逻辑一一对应，便于两边对照排查：
 *   登录：手机号 + 短信验证码 → app token
 *         token → grant 换 code → generate_cred_by_code 换 cred/签名 token → refresh
 *   签名：sign = md5( hex( hmac_sha256( key=token, msg=path+query+body+timestamp+meta ) ) )
 *   签到：/api/v1/game/attendance（方舟）、/api/v1/game/endfield/attendance（终末地）
 *
 * 这里没有任何硬编码凭据：token 一律来自本地加密存储。
 */

const crypto = require('node:crypto');
const { request, requestJson, errorText, CheckinError, CredentialExpired } = require('./http');

const GRANT_URL = 'https://as.hypergryph.com/user/oauth2/v2/grant';
const HYPER_BASE = 'https://as.hypergryph.com';
const ZONAI_BASE = 'https://zonai.skland.com';

const APP_CODE = '4ca99fa6b56cc2ba'; // 森空岛在鹰角通行证的 appCode
const PLATFORM = '3';
const VNAME = '1.0.0';
const TS_OFFSET = 2; // 签名时间戳回拨 2 秒，规避服务端时间校验

const SKLAND_UA =
  'Mozilla/5.0 (Linux; Android 12; SM-A5560 Build/V417IR; wv) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Version/4.0 Chrome/101.0.4951.61 Safari/537.36; SKLand/1.52.1';
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const ARKNIGHTS_GAME_ID = 1;
const ENDFIELD_GAME_ID = 3;

const BOARDS = {
  arknights: { code: 'arknights', gameId: ARKNIGHTS_GAME_ID, label: '明日方舟' },
  endfield: { code: 'endfield', gameId: ENDFIELD_GAME_ID, label: '明日方舟：终末地' },
};

/* ------------------------------------------------------------------ 工具 */

/** 与 JS 的 JSON.stringify 一致的紧凑 JSON（键顺序即声明顺序，参与签名） */
function compact(obj) {
  return JSON.stringify(obj);
}

/** token 各种复制粘贴形态的归一化 */
function normalizeToken(raw) {
  let text = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      const content = parsed && parsed.data && parsed.data.content;
      if (typeof content === 'string' && content.trim()) text = content;
    } catch {
      /* 不是 JSON 就按原样处理 */
    }
  }
  if (/^bearer\s+/i.test(text)) text = text.slice(7);
  if (text.includes('%')) {
    try {
      const decoded = decodeURIComponent(text);
      if (decoded !== text) text = decoded;
    } catch {
      /* 非法百分号编码，忽略 */
    }
  }
  return text.replace(/\s+/g, '');
}

/** base64 补位，不改变解码结果 */
function padBase64(token) {
  const rest = token.length % 4;
  return rest ? token + '='.repeat(4 - rest) : token;
}

/** 本地体检：明显不对的 token 直接拦下，免得等服务器报天书 */
function parseToken(raw) {
  const token = normalizeToken(raw);
  if (!token) throw new CheckinError('森空岛 token 为空，请重新登录。');
  if (token.length < 20) {
    throw new CheckinError(
      `森空岛 token 长度只有 ${token.length} 位（正常约 24 位），可能复制不完整，请重新登录。`
    );
  }
  if (!/^[A-Za-z0-9+/=_-]+$/.test(token)) {
    const bad = [...new Set(token.split('').filter((ch) => !/[A-Za-z0-9+/=_-]/.test(ch)))];
    throw new CheckinError(`森空岛 token 含有非法字符（${bad.slice(0, 5).join(' ')}），请重新登录。`);
  }
  return padBase64(token);
}

/** 鹰角通行证接口的成功标志是 {status: 0} 或 {code: 0} */
function hyperOk(payload) {
  return !!payload && (payload.status === 0 || payload.code === 0);
}

/* ------------------------------------------------------------------ 登录 */

function hyperHeaders(deviceId, extra = {}) {
  return {
    'user-agent': SKLAND_UA,
    'content-type': 'application/json',
    dId: deviceId,
    'x-requested-with': 'com.hypergryph.skland',
    ...extra,
  };
}

/** 下发短信验证码（type=2 表示登录用） */
async function sendPhoneCode(phone, deviceId, options = {}) {
  const res = await requestJson(`${HYPER_BASE}/general/v1/send_phone_code`, {
    method: 'POST',
    headers: hyperHeaders(deviceId),
    json: { phone, type: 2 },
    label: '发送森空岛验证码',
    signal: options.signal,
  });
  if (!hyperOk(res.json)) {
    throw new CheckinError(`发送验证码失败：${errorText(res.json) || '未知错误'}`);
  }
  return { ok: true };
}

/** 手机号 + 验证码换 app token */
async function loginByPhoneCode(phone, code, deviceId, options = {}) {
  const res = await requestJson(`${HYPER_BASE}/user/auth/v2/token_by_phone_code`, {
    method: 'POST',
    headers: hyperHeaders(deviceId),
    json: { phone, code },
    label: '森空岛验证码登录',
    signal: options.signal,
  });
  if (!hyperOk(res.json)) {
    throw new CheckinError(`登录失败：${errorText(res.json) || '验证码错误或已过期'}`);
  }
  const token = String((res.json.data && res.json.data.token) || '').trim();
  if (!token) throw new CheckinError('登录失败：服务器没有返回 token');
  return token;
}

/* -------------------------------------------------------------- 客户端 */

class SklandClient {
  constructor(appToken, deviceId, options = {}) {
    this.appToken = parseToken(appToken);
    this.deviceId = deviceId;
    this.signal = options.signal;
    this.cred = '';
    this.signToken = '';
  }

  signedHeaders(pathname, query = '', bodyStr = '', extra = {}) {
    const timestamp = String(Math.floor(Date.now() / 1000) - TS_OFFSET);
    const meta = { platform: PLATFORM, timestamp, dId: this.deviceId, vName: VNAME };
    const raw = `${pathname}${query}${bodyStr}${timestamp}${compact(meta)}`;
    const digest = crypto.createHmac('sha256', this.signToken).update(raw, 'utf8').digest('hex');
    const sign = crypto.createHash('md5').update(digest, 'utf8').digest('hex');
    return {
      cred: this.cred,
      platform: PLATFORM,
      timestamp,
      dId: this.deviceId,
      vName: VNAME,
      sign,
      'user-agent': SKLAND_UA,
      'x-requested-with': 'com.hypergryph.skland',
      ...(bodyStr ? { 'content-type': 'application/json' } : {}),
      ...extra,
    };
  }

  async request(pathname, { method = 'GET', query, body, extraHeaders, label = '森空岛接口' } = {}) {
    const qs = query ? new URLSearchParams(query).toString() : '';
    const bodyStr = body !== undefined ? compact(body) : '';
    const url = `${ZONAI_BASE}${pathname}${qs ? `?${qs}` : ''}`;
    const res = await requestJson(url, {
      method,
      headers: this.signedHeaders(pathname, qs, bodyStr, extraHeaders),
      json: body,
      label,
      signal: this.signal,
    });
    return res.json;
  }

  /** token → cred / 签名 token */
  async login() {
    // 1) app token 换一次性 code（该接口成功标志是 status:0，不是 code:0）
    const granted = await requestJson(GRANT_URL, {
      method: 'POST',
      headers: hyperHeaders(this.deviceId),
      json: { appCode: APP_CODE, token: this.appToken, type: 0 },
      label: '森空岛 token 换取 code',
      signal: this.signal,
    });
    if (!hyperOk(granted.json)) {
      const message = errorText(granted.json) || '';
      const lowered = message.toLowerCase();
      if (
        (granted.json && granted.json.status === 3) ||
        /过期|重新登录|expired/.test(message) ||
        lowered.includes('expired')
      ) {
        throw new CredentialExpired(`森空岛 token 已过期或无效（${message}），请重新登录。`);
      }
      throw new CheckinError(`token 换取 code 失败：${message || '未知错误'}`);
    }
    const code = granted.json.data && granted.json.data.code;
    if (!code) throw new CheckinError('token 换取 code 失败：返回里没有 code 字段');

    // 2) code → cred + 签名 token
    const credRes = await requestJson(`${ZONAI_BASE}/web/v1/user/auth/generate_cred_by_code`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': WEB_UA,
        referer: 'https://www.skland.com/',
        origin: 'https://www.skland.com',
        dId: this.deviceId,
        platform: PLATFORM,
        timestamp: String(Math.floor(Date.now() / 1000)),
        vName: VNAME,
      },
      json: { code, kind: 1 },
      label: '森空岛 code 换取 cred',
      signal: this.signal,
    });
    if (!credRes.json || credRes.json.code !== 0) {
      throw new CheckinError(
        `code 换取 cred 失败：${errorText(credRes.json) || '未知错误'}`
      );
    }
    const payload = credRes.json.data || {};
    this.cred = payload.cred || '';
    this.signToken = payload.token || '';
    if (!this.cred || !this.signToken) {
      throw new CheckinError('code 换取 cred 失败：返回字段缺失');
    }

    // 3) 刷新签名 token
    const refreshed = await this.request('/web/v1/auth/refresh', { label: '森空岛刷新签名 key' });
    if (!refreshed || refreshed.code !== 0) {
      throw new CheckinError(`刷新签名 key 失败：${errorText(refreshed) || '未知错误'}`);
    }
    const newToken = refreshed.data && refreshed.data.token;
    if (!newToken) throw new CheckinError('刷新签名 key 失败：返回中缺少 token');
    this.signToken = newToken;
  }

  /** 绑定角色列表 */
  async bindings() {
    const data = await this.request('/api/v1/game/player/binding', { label: '森空岛角色绑定' });
    if (!data || data.code !== 0) {
      throw new CheckinError(`获取绑定角色失败：${errorText(data) || '未知错误'}`);
    }
    return (data.data && data.data.list) || [];
  }

  async arknightsStatus(uid, gameId = ARKNIGHTS_GAME_ID) {
    const data = await this.request('/api/v1/game/attendance', {
      query: { uid, gameId },
      label: '森空岛签到状态',
    });
    if (!data || data.code !== 0) throw new CheckinError(errorText(data) || '查询签到状态失败');
    return data.data || {};
  }

  arknightsAttendance(uid, gameId = ARKNIGHTS_GAME_ID) {
    return this.request('/api/v1/game/attendance', {
      method: 'POST',
      body: { gameId, uid },
      label: '明日方舟签到',
    });
  }

  async endfieldStatus(roleId, serverId, gameId = ENDFIELD_GAME_ID) {
    const data = await this.request('/api/v1/game/endfield/attendance', {
      extraHeaders: { 'sk-game-role': `${gameId}_${roleId}_${serverId}` },
      label: '终末地签到状态',
    });
    if (!data || data.code !== 0) throw new CheckinError(errorText(data) || '查询签到状态失败');
    return data.data || {};
  }

  endfieldAttendance(roleId, serverId, gameId = ENDFIELD_GAME_ID) {
    return this.request('/api/v1/game/endfield/attendance', {
      method: 'POST',
      extraHeaders: {
        'sk-game-role': `${gameId}_${roleId}_${serverId}`,
        referer: 'https://game.skland.com/',
        origin: 'https://game.skland.com',
      },
      label: '终末地签到',
    });
  }
}

/* ------------------------------------------------------------ 奖励文案 */

function awardsTextArknights(data) {
  const list = (data && data.awards) || [];
  return list
    .map((award) => {
      const resource = award.resource || {};
      const name = resource.name || '未知奖励';
      const count = award.count || resource.count || 1;
      return `${name}×${count}`;
    })
    .join('、');
}

function awardsTextEndfield(data) {
  const infoMap = (data && data.resourceInfoMap) || {};
  const ids = (data && data.awardIds) || [];
  return ids
    .map((item) => {
      const info = infoMap[item.id] || {};
      return `${info.name || '未知奖励'}×${info.count || 1}`;
    })
    .join('、');
}

/** 森空岛按东八区自然日结算，records 里出现今天即视为已签到 */
function arknightsSignedToday(status) {
  const now = new Date();
  const todayInCst = new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  for (const record of (status && status.records) || []) {
    const ts = Number(record.ts) || 0;
    if (!ts) continue;
    const day = new Date(ts * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
    if (day === todayInCst) return true;
  }
  return false;
}

const jitter = (min, max) =>
  new Promise((resolve) => setTimeout(resolve, (min + Math.random() * (max - min)) * 1000));

/* ------------------------------------------------------------ 签到主流程 */

/**
 * 对一个账号执行签到。
 * @param {object} account  完整账号对象（含 token / deviceId）
 * @param {object} options
 * @param {string[]} [options.boards]
 * @param {(level:string, text:string)=>void} [options.log]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{results:object[], failures:number, info:object}>}
 */
async function runCheckin(account, options = {}) {
  const log = options.log || (() => {});
  const results = [];
  const add = (board, role, status, detail = '') =>
    results.push({ board, role, status, detail });
  let failures = 0;

  const client = new SklandClient(account.token, account.deviceId, { signal: options.signal });
  await client.login();
  log('info', '森空岛凭据校验通过');

  const groups = await client.bindings();
  const byApp = {};
  for (const item of groups) {
    const appCode = item.appCode || '';
    byApp[appCode] = byApp[appCode] || [];
    byApp[appCode].push(...(item.bindingList || []));
  }

  const boards = (options.boards && options.boards.length ? options.boards : ['arknights', 'endfield'])
    .filter((code) => BOARDS[code]);

  let firstNick = '';
  let firstUid = '';

  for (const code of boards) {
    const board = BOARDS[code];
    const players = byApp[code] || [];

    if (!players.length) {
      log('warn', `${board.label}：该账号没有绑定角色，已跳过`);
      add(board.label, '-', 'skip', '没有绑定角色');
      continue;
    }

    if (code === 'arknights') {
      for (const player of players) {
        const uid = String(player.uid || '');
        const nick = player.nickName || '未知角色';
        const channel = player.channelName || '';
        const roleLabel = nick + (channel ? `（${channel}）` : '');
        const tag = `${board.label} · ${roleLabel}`;
        if (!firstNick) {
          firstNick = nick;
          firstUid = uid;
        }
        if (!uid) {
          log('warn', `${tag}：缺少 uid，已跳过`);
          add(board.label, roleLabel, 'skip', '缺少 uid');
          continue;
        }
        const gameId = Number(player.gameId) || ARKNIGHTS_GAME_ID;

        try {
          const status = await client.arknightsStatus(uid, gameId);
          if (arknightsSignedToday(status)) {
            log('ok', `${tag}：今天已经签到过了`);
            add(board.label, roleLabel, 'already');
            await jitter(0.8, 1.5);
            continue;
          }
        } catch {
          /* 状态查询失败不阻断，继续尝试签到 */
        }

        try {
          const res = await client.arknightsAttendance(uid, gameId);
          const code2 = res && res.code;
          const message = errorText(res);
          if (code2 === 0) {
            const awards = awardsTextArknights(res.data);
            log('ok', `${tag}：签到成功${awards ? `，获得 ${awards}` : ''}`);
            add(board.label, roleLabel, 'success', awards ? `获得 ${awards}` : '');
          } else if (code2 === 10001 || message.includes('已') || /already/i.test(message)) {
            log('ok', `${tag}：今天已经签到过了`);
            add(board.label, roleLabel, 'already');
          } else {
            failures++;
            log('err', `${tag}：签到失败 —— ${message || '未知错误'}（code=${code2}）`);
            add(board.label, roleLabel, 'fail', message || `code=${code2}`);
          }
        } catch (err) {
          failures++;
          log('err', `${tag}：签到请求失败 —— ${err.message}`);
          add(board.label, roleLabel, 'fail', err.message);
        }
        await jitter(1.0, 2.5);
      }
    } else {
      for (const player of players) {
        const nick = player.nickName || '未知角色';
        let roles = Array.isArray(player.roles) ? player.roles : [];
        if (!roles.length && player.defaultRole) roles = [player.defaultRole];
        if (!roles.length) {
          log('warn', `${board.label} · ${nick}：没有可用角色，已跳过`);
          add(board.label, nick, 'skip', '没有可用角色');
          continue;
        }
        const gameId = Number(player.gameId) || ENDFIELD_GAME_ID;

        for (const role of roles) {
          const roleId = String(role.roleId || '');
          const serverId = String(role.serverId || '');
          const roleName = role.nickname || nick;
          const serverName = role.serverName || '';
          const roleLabel = roleName + (serverName ? `（${serverName}）` : '');
          const tag = `${board.label} · ${roleLabel}`;
          if (!firstNick) {
            firstNick = roleName;
            firstUid = roleId;
          }
          if (!roleId || !serverId) {
            log('warn', `${tag}：角色信息不完整，已跳过`);
            add(board.label, roleLabel, 'skip', '角色信息不完整');
            continue;
          }
          if (role.isBanned) {
            log('warn', `${tag}：角色被封禁，已跳过`);
            add(board.label, roleLabel, 'skip', '角色被封禁');
            continue;
          }

          try {
            const status = await client.endfieldStatus(roleId, serverId, gameId);
            if (status && status.hasToday) {
              log('ok', `${tag}：今天已经签到过了`);
              add(board.label, roleLabel, 'already');
              await jitter(0.8, 1.5);
              continue;
            }
          } catch {
            /* 状态查询失败不阻断 */
          }

          try {
            const res = await client.endfieldAttendance(roleId, serverId, gameId);
            const code2 = res && res.code;
            const message = errorText(res);
            if (code2 === 0) {
              const awards = awardsTextEndfield(res.data);
              log('ok', `${tag}：签到成功${awards ? `，获得 ${awards}` : ''}`);
              add(board.label, roleLabel, 'success', awards ? `获得 ${awards}` : '');
            } else if (code2 === 10001 || message.includes('已') || /already/i.test(message)) {
              log('ok', `${tag}：今天已经签到过了`);
              add(board.label, roleLabel, 'already');
            } else {
              failures++;
              log('err', `${tag}：签到失败 —— ${message || '未知错误'}（code=${code2}）`);
              add(board.label, roleLabel, 'fail', message || `code=${code2}`);
            }
          } catch (err) {
            failures++;
            log('err', `${tag}：签到请求失败 —— ${err.message}`);
            add(board.label, roleLabel, 'fail', err.message);
          }
          await jitter(1.0, 2.5);
        }
      }
    }
  }

  return { results, failures, info: { nickName: firstNick, uid: firstUid } };
}

/** 登录后立刻探一次角色，用来确认凭据可用并取出昵称 */
async function probeAccount(token, deviceId, options = {}) {
  const client = new SklandClient(token, deviceId, { signal: options.signal });
  await client.login();
  const groups = await client.bindings();
  let nickName = '';
  let uid = '';
  for (const item of groups) {
    for (const player of item.bindingList || []) {
      if (!nickName && player.nickName) nickName = player.nickName;
      if (!uid && player.uid) uid = String(player.uid);
    }
  }
  return { nickName, uid, groupCount: groups.length };
}

module.exports = {
  BOARD_LABELS: BOARDS,
  sendPhoneCode,
  loginByPhoneCode,
  probeAccount,
  runCheckin,
  SklandClient,
  parseToken,
  normalizeToken,
};
