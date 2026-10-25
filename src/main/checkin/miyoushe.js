'use strict';

/**
 * miyoushe.js — 米游社（崩坏：星穹铁道 / 绝区零）登录与签到
 *
 * 由 miyoushe-checkin/mihoyo_checkin.py 移植到 Node：
 *   登录：手机号 + 短信验证码（RSA 加密手机号 + App 端 DS）→ stoken / uid / mid
 *         stoken → cookie_token（签到接口认 account_id + cookie_token）
 *   签到：getUserGameRolesByCookie 取角色 → event/luna/info 查状态 → event/luna/sign 签到
 *   签名：DS = t,r,md5(salt=&t=&r=)，网页端与 App 端使用两套不同的盐
 *
 * 凭据全部来自本地加密存储，源码里没有任何硬编码的 token / cookie。
 */

const crypto = require('node:crypto');
const {
  request,
  requestJson,
  errorText,
  deviceId: newDeviceId,
  sleep,
  CheckinError,
  CaptchaRequired,
  CredentialExpired,
} = require('./http');

/* ---------------------------------------------------------------- 常量 */

const APP_VERSION = '2.109.0'; // 签到链路版本号，与 SALT_WEB 必须配套
const SALT_WEB = 'd9200c846b10886e8c874fc33c8f308b';
const CLIENT_TYPE_WEB = '5';

const UA =
  'Mozilla/5.0 (Linux; Android 12; Unspecified Device) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Version/4.0 Chrome/103.0.5060.129 Mobile Safari/537.36 ' +
  `miHoYoBBS/${APP_VERSION}`;

const TAKUMI_HOST = 'https://api-takumi.mihoyo.com';
const URL_COOKIE_TOKEN = `${TAKUMI_HOST}/auth/api/getCookieAccountInfoBySToken`;
const URL_GAME_ROLES = `${TAKUMI_HOST}/binding/api/getUserGameRolesByCookie`;

const PASSPORT_HOST = 'https://passport-api.mihoyo.com';
const APP_VERSION_LOGIN = '2.81.1';
const APP_ID = 'bll8iq97cem8';
const APP_SALT = 'QVu5OdwEWxkq9ygpYBgDprR5tI471HWQ';
const AREA_CODE = '+86';

const APP_UA =
  'Mozilla/5.0 (Linux; Android 13; 22011211C Build/TP1A.220624.014; wv) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Version/4.0 Chrome/104.0.5112.97 Mobile Safari/537.36 ' +
  `miHoYoBBS/${APP_VERSION_LOGIN}`;

const APP_DEVICE_NAME = 'Xiaomi 22011211C';
const APP_DEVICE_MODEL = '22011211C';
const APP_SYS_VERSION = '13';
const APP_CHANNEL = 'miyousheluodi';

const URL_CREATE_LOGIN_CAPTCHA = `${PASSPORT_HOST}/account/ma-cn-verifier/verifier/createLoginCaptcha`;
const URL_LOGIN_BY_MOBILE = `${PASSPORT_HOST}/account/ma-cn-passport/app/loginByMobileCaptcha`;

/** App 端提交手机号时用的 RSA 公钥（米哈游客户端内置，公开信息） */
const RSA_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDDvekdPMHN3AYhm/vktJT+YJr7
cI5DcsNKqdsx5DZX0gDuWFuIjzdwButrIYPNmRJ1G8ybDIF7oDW2eEpm5sMbL9zs
9ExXCdvqrn51qELbqj0XxtMTIpaCHFSI50PfPpTFV9Xt/hmyVwokoOXFlAEgCn+Q
CgGs52bFoYMtyi+xEQIDAQAB
-----END PUBLIC KEY-----`;

const COOKIE_UID_KEYS = ['account_id', 'ltuid', 'login_uid', 'ltuid_v2', 'account_id_v2'];

const GAMES = {
  sr: {
    code: 'sr',
    name: '崩坏：星穹铁道',
    gameBiz: 'hkrpg_cn',
    actId: 'e202304121516551',
    rewardUrl: `${TAKUMI_HOST}/event/luna/home?lang=zh-cn`,
    infoUrl: `${TAKUMI_HOST}/event/luna/info?lang=zh-cn`,
    signUrl: `${TAKUMI_HOST}/event/luna/sign`,
    signGame: '',
  },
  zzz: {
    code: 'zzz',
    name: '绝区零',
    gameBiz: 'nap_cn',
    actId: 'e202406242138391',
    rewardUrl: 'https://act-nap-api.mihoyo.com/event/luna/zzz/home?lang=zh-cn',
    infoUrl: 'https://act-nap-api.mihoyo.com/event/luna/zzz/info?lang=zh-cn',
    signUrl: 'https://act-nap-api.mihoyo.com/event/luna/zzz/sign',
    signGame: 'zzz',
  },
};

/* ---------------------------------------------------------------- 工具 */

const md5 = (text) => crypto.createHash('md5').update(text, 'utf8').digest('hex');

const randomChars = (pool, length) => {
  let out = '';
  for (let i = 0; i < length; i++) out += pool[crypto.randomInt(pool.length)];
  return out;
};

/** 签到链路（网页端）DS */
function dsWeb() {
  const t = String(Math.floor(Date.now() / 1000));
  const r = randomChars('abcdefghijklmnopqrstuvwxyz0123456789', 6);
  return `${t},${r},${md5(`salt=${SALT_WEB}&t=${t}&r=${r}`)}`;
}

/** 登录链路（App 端）DS，用的是另一套盐 */
function dsApp() {
  const t = String(Math.floor(Date.now() / 1000));
  const r = randomChars('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 6);
  return `${t},${r},${md5(`salt=${APP_SALT}&t=${t}&r=${r}`)}`;
}

/** PKCS#1 v1.5 加密 + Base64（与官方 App 提交手机号的方式一致） */
function rsaEncrypt(text) {
  const buffer = crypto.publicEncrypt(
    { key: RSA_PUBLIC_KEY_PEM, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(text, 'utf8')
  );
  return buffer.toString('base64');
}

function appHeaders(deviceId, extra = {}) {
  return {
    'accept-encoding': 'gzip',
    'user-agent': APP_UA,
    referer: 'https://app.mihoyo.com',
    DS: dsApp(),
    'content-type': 'application/json; charset=utf-8',
    'x-rpc-app_version': APP_VERSION_LOGIN,
    'x-rpc-app_id': APP_ID,
    'x-rpc-verify_key': APP_ID,
    'x-rpc-client_type': '2',
    'x-rpc-channel': APP_CHANNEL,
    'x-rpc-device_id': deviceId,
    'x-rpc-device_name': APP_DEVICE_NAME,
    'x-rpc-device_model': APP_DEVICE_MODEL,
    'x-rpc-sys_version': APP_SYS_VERSION,
    ...extra,
  };
}

function buildUrl(base, params) {
  if (!params || !Object.keys(params).length) return base;
  const qs = new URLSearchParams(params).toString();
  return base + (base.includes('?') ? '&' : '?') + qs;
}

function normalizePhone(raw) {
  let phone = String(raw || '').replace(/[\s\-+()]/g, '');
  if (phone.length === 13 && phone.startsWith('86')) phone = phone.slice(2);
  return phone;
}

/* ---------------------------------------------------------------- 登录 */

/** 下发短信验证码 */
async function sendPhoneCode(phone, deviceId, options = {}) {
  const res = await requestJson(URL_CREATE_LOGIN_CAPTCHA, {
    method: 'POST',
    headers: appHeaders(deviceId),
    json: { area_code: rsaEncrypt(AREA_CODE), mobile: rsaEncrypt(phone) },
    label: '发送米游社验证码',
    signal: options.signal,
  });
  const payload = res.json || {};
  const retcode = payload.retcode;
  if (retcode === 0) return { ok: true };

  if (retcode === -3101) {
    let aigis = '';
    try {
      aigis = res.headers.get('x-rpc-aigis') || '';
    } catch {
      aigis = '';
    }
    throw new CaptchaRequired(
      '发送验证码触发了人机验证（极验滑块）。建议：过一段时间再试，或在米游社 App 里先登录一次。' +
        (aigis ? `（服务端会话：${aigis.slice(0, 40)}）` : ''),
      { stage: 'login' }
    );
  }

  const known = {
    '-3001': '手机号格式错误',
    '-3008': '手机号格式错误',
    '-3009': '该手机号尚未注册米哈游通行证',
    '-3205': '验证码错误或已过期',
    '-3101': '发送过于频繁，请稍后再试',
  };
  throw new CheckinError(
    `发送验证码失败：${known[String(retcode)] || errorText(payload) || '未知错误'}（retcode=${retcode}）`
  );
}

/** 验证码登录，直接拿到 uid / mid / stoken */
async function loginByPhoneCode(phone, code, deviceId, options = {}) {
  const res = await requestJson(URL_LOGIN_BY_MOBILE, {
    method: 'POST',
    headers: appHeaders(deviceId),
    json: {
      area_code: rsaEncrypt(AREA_CODE),
      mobile: rsaEncrypt(phone),
      action_type: 'login_by_mobile_captcha',
      captcha: String(code || '').trim(),
    },
    label: '米游社验证码登录',
    signal: options.signal,
  });
  const payload = res.json || {};
  if (payload.retcode !== 0) {
    const known = {
      '-3205': '验证码错误或已过期',
      '-3208': '验证码错误次数过多，请稍后再试',
      '-3101': '操作过于频繁，请稍后再试',
    };
    throw new CheckinError(
      `登录失败：${known[String(payload.retcode)] || errorText(payload) || '未知错误'}（retcode=${payload.retcode}）`
    );
  }
  const data = payload.data || {};
  const userInfo = data.user_info || {};
  const token = String((data.token && data.token.token) || '').trim();
  const uid = String(userInfo.aid || '').trim();
  const mid = String(userInfo.mid || '').trim();
  if (!token || !uid) throw new CheckinError('登录响应缺少 stoken 或 uid，无法继续');
  return { uid, mid, stoken: token, loginTicket: String(data.login_ticket || '') };
}

/** stoken → cookie_token */
async function fetchCookieToken(stoken, mid = '', options = {}) {
  const cookie = mid ? `mid=${mid};stoken=${stoken}` : `stoken=${stoken}`;
  const res = await requestJson(URL_COOKIE_TOKEN, {
    headers: appHeaders(newDeviceId(), { cookie }),
    label: '米游社换取 cookie_token',
    signal: options.signal,
  });
  const payload = res.json || {};
  if (payload.retcode !== 0) {
    return { error: errorText(payload) || `retcode=${payload.retcode}` };
  }
  return payload.data || {};
}

/* -------------------------------------------------------------- 签到客户端 */

function buildCookie(account) {
  const parts = [];
  const uid = String(account.uid || '').trim();
  const cookieToken = String(account.cookieToken || '').trim();
  const stoken = String(account.stoken || '').trim();
  if (uid) parts.push(`account_id=${uid}`);
  if (cookieToken) parts.push(`cookie_token=${cookieToken}`);
  if (stoken) {
    parts.push(`stuid=${uid}`);
    parts.push(`stoken=${stoken}`);
  }
  if (account.mid) parts.push(`mid=${account.mid}`);
  if (account.ltoken) {
    parts.push(`ltuid=${uid}`);
    parts.push(`ltoken=${account.ltoken}`);
  }
  return parts.join('; ');
}

class SignClient {
  /**
   * @param {object} account 完整账号对象
   * @param {object} options { signal, onCredentialRefresh }
   */
  constructor(account, options = {}) {
    this.account = { ...account };
    this.signal = options.signal;
    this.onCredentialRefresh = options.onCredentialRefresh || null;
    this.cookie = buildCookie(this.account);
    this.deviceId = String(options.deviceId || this.account.deviceId || newDeviceId());
  }

  headers(game) {
    const headers = {
      accept: 'application/json, text/plain, */*',
      DS: dsWeb(),
      'x-rpc-channel': APP_CHANNEL,
      origin: 'https://act.mihoyo.com',
      'x-rpc-app_version': APP_VERSION,
      'user-agent': UA,
      'x-rpc-client_type': CLIENT_TYPE_WEB,
      referer: 'https://act.mihoyo.com/',
      'accept-language': 'zh-CN,zh;q=0.9',
      'x-requested-with': 'com.mihoyo.hyperion',
      cookie: this.cookie,
      'x-rpc-device_id': this.deviceId,
    };
    if (game && game.signGame) headers['X-Rpc-Signgame'] = game.signGame;
    return headers;
  }

  /** cookie_token 过期时用 stoken 换一个新的，并回调落盘 */
  async refreshCookieToken() {
    const stoken = String(this.account.stoken || '').trim();
    const uid = String(this.account.uid || '').trim();
    if (!stoken || !uid) return false;
    const data = await fetchCookieToken(stoken, String(this.account.mid || ''), {
      signal: this.signal,
    });
    const token = String(data.cookie_token || '').trim();
    if (!token) return false;
    this.account.cookieToken = token;
    if (!this.account.mid && data.mid) this.account.mid = String(data.mid);
    this.cookie = buildCookie(this.account);
    if (this.onCredentialRefresh) {
      try {
        this.onCredentialRefresh({ cookieToken: token, mid: this.account.mid });
      } catch {
        /* 续期已成功，落盘失败不应中断签到 */
      }
    }
    return true;
  }

  async call(url, { method = 'GET', params, body, game, label = '米游社接口', retried = false } = {}) {
    const res = await requestJson(buildUrl(url, params), {
      method,
      headers: this.headers(game),
      json: body,
      label,
      signal: this.signal,
    });
    const payload = res.json || {};
    const retcode = payload.retcode;
    if ([-100, -200, 10001].includes(retcode) && !retried) {
      const refreshed = await this.refreshCookieToken();
      if (refreshed) {
        return this.call(url, { method, params, body, game, label, retried: true });
      }
    }
    return payload;
  }

  async gameRoles(game) {
    const payload = await this.call(URL_GAME_ROLES, {
      params: { game_biz: game.gameBiz },
      label: `${game.name} 角色列表`,
    });
    if (payload.retcode !== 0) {
      throw new CheckinError(
        `获取${game.name}角色列表失败：${errorText(payload) || `retcode=${payload.retcode}`}`
      );
    }
    const list = (payload.data && payload.data.list) || [];
    return list.map((item) => ({
      nickname: item.nickname || '未知角色',
      uid: String(item.game_uid || ''),
      region: String(item.region || ''),
      level: item.level,
    }));
  }

  async rewards(game) {
    const payload = await this.call(game.rewardUrl, {
      params: { act_id: game.actId },
      game,
      label: `${game.name} 奖励列表`,
    });
    if (payload.retcode !== 0) return [];
    return (payload.data && payload.data.awards) || [];
  }

  async info(game, uid, region) {
    const payload = await this.call(game.infoUrl, {
      params: { act_id: game.actId, region, uid },
      game,
      label: `${game.name} 签到状态`,
    });
    if (payload.retcode !== 0) {
      throw new CheckinError(
        `查询签到状态失败：${errorText(payload) || `retcode=${payload.retcode}`}`
      );
    }
    return payload.data || {};
  }

  /** 执行签到，返回 { state: 'success'|'already'|'fail', detail } */
  async sign(game, uid, region) {
    const payload = await this.call(game.signUrl, {
      method: 'POST',
      body: { act_id: game.actId, region, uid },
      game,
      label: `${game.name} 签到`,
    });
    const retcode = payload.retcode;
    const data = payload.data || {};
    if (retcode === -5003) return { state: 'already', detail: '今天已经签到过了' };
    if (retcode === 0 && data.success === 0) return { state: 'success', detail: '' };
    if (data.success === 1) {
      throw new CaptchaRequired(`${game.name} 签到触发人机验证（滑块），请在米游社 App 里手动签到一次。`, {
        stage: 'sign',
      });
    }
    return {
      state: 'fail',
      detail: `${errorText(payload) || '未知错误'}（retcode=${retcode}）`,
    };
  }
}

/* ---------------------------------------------------------------- 奖励 */

function awardText(rewards, day) {
  if (!Array.isArray(rewards) || !rewards.length || day < 1) return '';
  const item = rewards[Math.min(day - 1, rewards.length - 1)] || {};
  return `「${item.name || '未知奖励'}」x${item.cnt || item.count || 1}`;
}

/* ------------------------------------------------------------ 签到主流程 */

/**
 * @param {object} account 完整账号对象（stoken / uid / mid / cookieToken / deviceId）
 * @param {object} options { boards, log, signal, onCredentialRefresh }
 */
async function runCheckin(account, options = {}) {
  const log = options.log || (() => {});
  const results = [];
  const add = (board, role, status, detail = '') =>
    results.push({ board, role, status, detail });
  let failures = 0;

  if (!account.stoken && !account.cookieToken) {
    throw new CredentialExpired('该账号还没有保存米游社凭据，请先登录。');
  }

  const client = new SignClient(account, {
    signal: options.signal,
    deviceId: account.deviceId,
    onCredentialRefresh: options.onCredentialRefresh,
  });

  const boards = (options.boards && options.boards.length ? options.boards : ['sr', 'zzz']).filter(
    (code) => GAMES[code]
  );

  for (const [index, code] of boards.entries()) {
    const game = GAMES[code];
    let roles;
    try {
      roles = await client.gameRoles(game);
    } catch (err) {
      failures++;
      log('err', `${game.name}：${err.message}`);
      add(game.name, '-', 'fail', err.message);
      // 连角色列表都取不到，说明凭据本身坏了，没必要再去下一个游戏重试一遍
      if (index === 0) throw new CredentialExpired(`${err.message}；请重新登录米游社账号。`);
      continue;
    }

    if (!roles.length) {
      log('warn', `${game.name}：该账号没有绑定角色，已跳过`);
      add(game.name, '-', 'skip', '没有绑定角色');
      continue;
    }

    const rewards = await client.rewards(game);

    for (const [roleIndex, role] of roles.entries()) {
      const tag = `${game.name} · ${role.nickname}`;
      if (!role.uid || !role.region) {
        log('warn', `${tag}：角色信息不完整，已跳过`);
        add(game.name, role.nickname, 'skip', '角色信息不完整');
        continue;
      }
      if (roleIndex > 0) await sleep(3000 + Math.random() * 3000);

      let before;
      try {
        before = await client.info(game, role.uid, role.region);
      } catch (err) {
        failures++;
        log('err', `${tag}：查询签到状态失败 —— ${err.message}`);
        add(game.name, role.nickname, 'fail', err.message);
        continue;
      }

      if (before.first_bind) {
        log('warn', `${tag}：首次绑定米游社，请先在米游社 App 里手动签到一次`);
        add(game.name, role.nickname, 'skip', '需先在 App 里手动签到一次');
        continue;
      }

      if (before.is_sign) {
        const award = awardText(rewards, Number(before.total_sign_day) || 0);
        const days = Number(before.total_sign_day) || 0;
        log('ok', `${tag}：今天已经签到过了${award ? `，今天获得 ${award}` : ''}`);
        add(
          game.name,
          role.nickname,
          'already',
          `已连续签到 ${days} 天${award ? `，今天获得 ${award}` : ''}`
        );
        continue;
      }

      await sleep(3000 + Math.random() * 3000);
      let result;
      try {
        result = await client.sign(game, role.uid, role.region);
      } catch (err) {
        failures++;
        log('err', `${tag}：${err.message}`);
        add(game.name, role.nickname, 'fail', err.message);
        continue;
      }

      if (result.state === 'already') {
        log('ok', `${tag}：今天已经签到过了`);
        add(game.name, role.nickname, 'already');
        continue;
      }
      if (result.state !== 'success') {
        failures++;
        log('err', `${tag}：签到失败 —— ${result.detail}`);
        add(game.name, role.nickname, 'fail', result.detail);
        continue;
      }

      const days = (Number(before.total_sign_day) || 0) + 1;
      const award = awardText(rewards, days);
      log('ok', `${tag}：签到成功${award ? `，获得 ${award}` : ''}`);
      add(
        game.name,
        role.nickname,
        'success',
        `连续签到 ${days} 天${award ? `，获得 ${award}` : ''}`
      );
    }
  }

  return { results, failures, info: {} };
}

/** 登录成功后探一次角色，确认凭据可用并取昵称 */
async function probeAccount(account, options = {}) {
  const client = new SignClient(account, {
    signal: options.signal,
    deviceId: account.deviceId,
  });
  const nicknames = [];
  let firstUid = account.uid || '';
  for (const game of Object.values(GAMES)) {
    try {
      const roles = await client.gameRoles(game);
      for (const role of roles) {
        if (role.nickname) nicknames.push(role.nickname);
        if (!firstUid && role.uid) firstUid = role.uid;
      }
    } catch {
      /* 某个游戏取不到不影响登录 */
    }
  }
  return { nickName: nicknames[0] || '', uid: firstUid, roleCount: nicknames.length };
}

module.exports = {
  GAME_LABELS: GAMES,
  normalizePhone,
  sendPhoneCode,
  loginByPhoneCode,
  fetchCookieToken,
  probeAccount,
  runCheckin,
  SignClient,
  dsWeb,
  dsApp,
  rsaEncrypt,
  newDeviceId,
  COOKIE_UID_KEYS,
};
