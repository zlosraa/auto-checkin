'use strict';

/**
 * index.js — 签到业务调度层
 *
 * 主进程只调这里的几个方法；具体协议细节都藏在 skland.js / miyoushe.js 里。
 * 这一层负责：
 *   · 发送验证码 / 登录 / 提取并保存凭据
 *   · 逐个账号签到，实时把日志推给界面（事件流），支持中途取消
 *   · 签到结束后按设置推送 Server酱，并把结果写进日志目录
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const skland = require('./skland');
const miyoushe = require('./miyoushe');
const { sendServerChan, buildDigest, maskKey } = require('./notify');
const { CheckinError, CaptchaRequired, CredentialExpired, deviceId: newDeviceId } = require('./http');

const KIND_META = {
  skland: { label: '森空岛', boards: ['arknights', 'endfield'] },
  miyoushe: { label: '米游社', boards: ['sr', 'zzz'] },
};

/**
 * @param {object} options
 * @param {ReturnType<import('../accounts').createAccountStore>} options.accounts
 * @param {string} options.logDir 运行记录目录
 */
function createCheckinService({ accounts, logDir }) {
  /** runId -> { controller, kind, startedAt } */
  const activeRuns = new Map();
  /** kind -> runId（同类同时只跑一个） */
  const activeByKind = new Map();

  /* -------------------------------------------------------- 验证码 / 登录 */

  async function sendCode(kind, phone) {
    const meta = KIND_META[kind];
    if (!meta) return { ok: false, error: `未知的签到类型：${kind}` };

    const normalized = String(phone || '').replace(/[\s\-+()]/g, '');
    const checked = kind === 'miyoushe' ? miyoushe.normalizePhone(normalized) : normalized;
    if (!/^1\d{10}$/.test(checked)) {
      return { ok: false, error: '请输入正确的 11 位手机号。' };
    }

    // 设备号在「发验证码」阶段就要用；登录成功后连同凭据一起存起来
    const deviceId = kind === 'miyoushe' ? newDeviceId() : crypto.randomUUID();
    try {
      if (kind === 'skland') {
        await skland.sendPhoneCode(checked, deviceId);
      } else {
        await miyoushe.sendPhoneCode(checked, deviceId);
      }
      return { ok: true, phone: checked, deviceId, message: `${meta.label}验证码已发送，请查看手机短信。` };
    } catch (err) {
      return { ok: false, error: friendly(err), captcha: err instanceof CaptchaRequired };
    }
  }

  /**
   * 验证码登录 → 提取凭据 → 探测角色 → 加密保存
   * @returns {{ok:boolean, account?:object, error?:string, action?:string}}
   */
  async function login(kind, payload = {}) {
    const meta = KIND_META[kind];
    if (!meta) return { ok: false, error: `未知的签到类型：${kind}` };

    const phone = String(payload.phone || '').replace(/[\s\-+()]/g, '');
    const code = String(payload.code || '').trim();
    const name = String(payload.name || '').trim();
    let deviceId = String(payload.deviceId || '').trim();

    if (!/^1\d{10}$/.test(phone)) return { ok: false, error: '请输入正确的 11 位手机号。' };
    if (!/^\d{4,8}$/.test(code)) return { ok: false, error: '请输入短信里的数字验证码。' };

    try {
      if (kind === 'skland') {
        deviceId = deviceId || crypto.randomUUID();
        const token = await skland.loginByPhoneCode(phone, code, deviceId);
        // 拿到 token 立刻试一次，既能验证凭据，也能顺手取昵称
        let probe = { nickName: '', uid: '' };
        try {
          probe = await skland.probeAccount(token, deviceId);
        } catch (err) {
          if (err instanceof CredentialExpired) throw err;
          // 探测失败不算登录失败：token 已经拿到了，状态查询失败可能只是接口抖动
        }
        const saved = accounts.upsert('skland', {
          name: name || probe.nickName || '',
          phone,
          token,
          deviceId,
          uid: probe.uid || '',
          nickName: probe.nickName || '',
          boards: meta.boards,
        });
        if (!saved.ok) return { ok: false, error: saved.error };
        return {
          ok: true,
          action: saved.action,
          account: publicOf('skland', saved.account),
          message: `${meta.label}账号已${saved.action === 'created' ? '添加' : '更新'}`,
        };
      }

      deviceId = deviceId || newDeviceId();
      const session = await miyoushe.loginByPhoneCode(phone, code, deviceId);
      const cookieData = await miyoushe.fetchCookieToken(session.stoken, session.mid);
      const cookieToken = String(cookieData.cookie_token || '').trim();

      let probe = { nickName: '', uid: session.uid };
      try {
        probe = await miyoushe.probeAccount({
          stoken: session.stoken,
          uid: session.uid,
          mid: session.mid,
          cookieToken,
          deviceId,
        });
      } catch {
        /* 探测失败不影响保存 */
      }

      const saved = accounts.upsert('miyoushe', {
        name: name || probe.nickName || '',
        phone,
        uid: session.uid,
        mid: session.mid || String(cookieData.mid || ''),
        stoken: session.stoken,
        cookieToken,
        deviceId,
        nickName: probe.nickName || '',
        boards: meta.boards,
      });
      if (!saved.ok) return { ok: false, error: saved.error };
      return {
        ok: true,
        action: saved.action,
        account: publicOf('miyoushe', saved.account),
        message: `${meta.label}账号已${saved.action === 'created' ? '添加' : '更新'}${
          cookieToken ? '' : '（未能换取 cookie_token，签到可能失败）'
        }`,
      };
    } catch (err) {
      return { ok: false, error: friendly(err), captcha: err instanceof CaptchaRequired };
    }
  }

  function publicOf(kind, account) {
    // 复用 accounts 模块里的脱敏规则：这里通过列表反查最简单
    const list = accounts.list(kind);
    return list.find((item) => item.id === account.id) || { id: account.id, name: account.name };
  }

  /* ------------------------------------------------------------ 签到运行 */

  function isRunning(kind) {
    return activeByKind.has(kind);
  }

  /**
   * 启动一次签到。
   * @param {'skland'|'miyoushe'} kind
   * @param {object} options
   * @param {string[]} [options.accountIds] 只跑指定账号；为空表示该类型全部账号
   * @param {(event:object)=>void} options.onEvent
   * @returns {{ok:boolean, runId?:string, error?:string, count?:number}}
   */
  function startRun(kind, options = {}) {
    const meta = KIND_META[kind];
    if (!meta) return { ok: false, error: `未知的签到类型：${kind}` };
    if (activeByKind.has(kind)) {
      return { ok: false, error: `${meta.label}正在签到中，请等待本次结束。` };
    }

    let list = accounts.all(kind);
    if (Array.isArray(options.accountIds) && options.accountIds.length) {
      const wanted = new Set(options.accountIds);
      list = list.filter((account) => wanted.has(account.id));
    }
    if (!list.length) {
      return { ok: false, error: `还没有${meta.label}账号，请先用手机号 + 验证码登录。` };
    }

    const runId = crypto.randomUUID();
    const controller = new AbortController();
    activeRuns.set(runId, { controller, kind, startedAt: Date.now() });
    activeByKind.set(kind, runId);

    // 异步执行，立刻把 runId 交回界面，日志走事件流
    (async () => {
      const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
      const emit = (type, payload = {}) => {
        try {
          onEvent({ runId, kind, type, ...payload });
        } catch {
          /* 回调异常不影响业务 */
        }
      };
      const startedAt = Date.now();
      const log = (level, text) => emit('log', { level, text: String(text) });
      const results = [];
      let failures = 0;
      let cancelled = false;

      emit('start', { label: meta.label, count: list.length, startedAt });
      log('info', `开始${meta.label}签到，共 ${list.length} 个账号`);

      for (const account of list) {
        if (controller.signal.aborted) {
          cancelled = true;
          break;
        }
        const accountName = account.name || '未命名账号';
        emit('account-start', { accountId: account.id, accountName });
        log('step', `── ${accountName} ──`);

        try {
          const runner = kind === 'skland' ? skland : miyoushe;
          const outcome = await runner.runCheckin(account, {
            boards: account.boards,
            signal: controller.signal,
            log,
            onCredentialRefresh: (patch) => {
              accounts.patch(kind, account.id, patch);
              log('info', '已自动续期 cookie_token 并保存');
            },
          });

          results.push(...outcome.results.map((item) => ({ ...item, account: accountName })));
          failures += outcome.failures;

          const accountFailed = outcome.results.some((r) => r.status === 'fail');
          accounts.patch(kind, account.id, {
            lastRunAt: new Date().toISOString(),
            lastRunStatus: accountFailed ? 'failed' : 'success',
            ...(outcome.info && outcome.info.nickName
              ? { nickName: outcome.info.nickName, uid: outcome.info.uid || account.uid }
              : {}),
          });
          emit('account-end', {
            accountId: account.id,
            status: accountFailed ? 'failed' : 'success',
            results: outcome.results,
          });
        } catch (err) {
          failures++;
          const message = friendly(err);
          results.push({ board: meta.label, role: accountName, status: 'fail', detail: message, account: accountName });
          accounts.patch(kind, account.id, {
            lastRunAt: new Date().toISOString(),
            lastRunStatus: 'failed',
          });
          if (err instanceof CredentialExpired) {
            const hint = message.includes('重新登录') ? message : `${message}（请在账号卡片上重新登录）`;
            log('err', `${accountName}：${hint}`);
          } else if (controller.signal.aborted) {
            cancelled = true;
            log('warn', '已取消剩余账号的签到');
            break;
          } else {
            log('err', `${accountName}：${message}`);
          }
          emit('account-end', { accountId: account.id, status: 'failed', results: [] });
        }
      }

      if (controller.signal.aborted) cancelled = true;
      const durationMs = Date.now() - startedAt;

      // ---- 汇总推送
      const digest = buildDigest({ label: meta.label, results, failures, startedAt, durationMs });
      const next = accounts.getServerChan();
      const shouldNotify =
        !cancelled &&
        next.enabled &&
        next.notifyOn !== 'never' &&
        !!next.sendKey &&
        (next.notifyOn === 'always' || digest.counts.fail > 0 || failures > 0);

      let notifyInfo = null;
      if (shouldNotify) {
        log('info', `正在通过 Server酱推送（SendKey ${maskKey(next.sendKey)}）…`);
        try {
          const res = await sendServerChan(next.sendKey, digest.title, digest.desp);
          notifyInfo = { ok: true, host: res.host, pushid: res.pushid };
          log('ok', `微信推送已发送（${res.host}${res.pushid ? `，pushid=${res.pushid}` : ''}）`);
        } catch (err) {
          notifyInfo = { ok: false, error: err.message };
          log('err', err.message);
        }
        emit('notify', notifyInfo);
      } else if (next.enabled && !next.sendKey) {
        log('warn', '未配置 Server酱 SendKey，已跳过微信推送（可在「设置与诊断」里填写）');
      } else if (next.enabled && next.notifyOn === 'failure' && !digest.counts.fail) {
        log('info', '本次没有失败项，按设置不推送');
      }

      // ---- 落盘运行记录
      const summary = {
        runId,
        kind,
        label: meta.label,
        startedAt,
        durationMs,
        cancelled,
        counts: digest.counts,
        notify: notifyInfo,
        results,
      };
      writeHistory(summary);

      activeRuns.delete(runId);
      if (activeByKind.get(kind) === runId) activeByKind.delete(kind);
      emit('exit', { ...summary, status: cancelled ? 'cancelled' : failures > 0 ? 'failed' : 'success' });
    })().catch((err) => {
      // 兜底：调度层自身异常也不能让界面一直转圈
      activeRuns.delete(runId);
      if (activeByKind.get(kind) === runId) activeByKind.delete(kind);
      try {
        options.onEvent?.({
          runId,
          kind,
          type: 'exit',
          status: 'error',
          errorMessage: `签到过程发生未预期错误：${err.message}`,
          results: [],
          counts: { success: 0, already: 0, fail: 1, skip: 0 },
          durationMs: 0,
        });
      } catch {
        /* ignore */
      }
    });

    return { ok: true, runId, count: list.length };
  }

  function cancel(runId) {
    const run = activeRuns.get(runId);
    if (!run) return { ok: false, error: '该任务已结束或不存在。' };
    run.controller.abort();
    return { ok: true };
  }

  function cancelAll() {
    for (const run of activeRuns.values()) run.controller.abort();
    return activeRuns.size;
  }

  function listRuns() {
    return [...activeRuns.entries()].map(([runId, run]) => ({
      runId,
      kind: run.kind,
      startedAt: run.startedAt,
    }));
  }

  /* -------------------------------------------------------------- 推送测试 */

  async function testNotify() {
    const settings = accounts.getServerChan();
    if (!settings.sendKey) return { ok: false, error: '还没有填写 Server酱 SendKey。' };
    try {
      const res = await sendServerChan(
        settings.sendKey,
        '签到工具箱 · 推送测试',
        [
          '这是一条测试消息，收到即说明 SendKey 配置正确。',
          '',
          `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        ].join('\n')
      );
      return { ok: true, message: `已发送（${res.host}${res.pushid ? `，pushid=${res.pushid}` : ''}）` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /* ------------------------------------------------------------ 运行记录 */

  function writeHistory(summary) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const day = new Date(summary.startedAt || Date.now()).toISOString().slice(0, 10);
      const file = path.join(logDir, `checkin-${day}.jsonl`);
      fs.appendFileSync(
        file,
        JSON.stringify({
          ...summary,
          // 只留必要字段，避免日志无限膨胀
          results: (summary.results || []).slice(0, 200),
        }) + '\n',
        'utf8'
      );
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  return {
    sendCode,
    login,
    startRun,
    cancel,
    cancelAll,
    isRunning,
    listRuns,
    testNotify,
    KIND_META,
  };
}

/** 把各种异常统一成可读中文 */
function friendly(err) {
  if (!err) return '未知错误';
  if (err instanceof CaptchaRequired || err instanceof CredentialExpired || err instanceof CheckinError) {
    return err.message;
  }
  if (err.name === 'AbortError') return '操作已被取消';
  return err.message || String(err);
}

module.exports = { createCheckinService, KIND_META, friendly };
