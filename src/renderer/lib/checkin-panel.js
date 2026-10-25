'use strict';

/**
 * checkin-panel.js — 签到类模块的公共界面
 *
 * 森空岛与米游社两个模块的交互完全一致（添加账号 → 一键签到 → 看日志），
 * 差异只有文案、配色和 kind。所以抽成工厂函数，模块入口只写「几十行配置」。
 *
 * 用法（modules/skland/module.js）：
 *   import { createCheckinModule } from '../../lib/checkin-panel.js';
 *   export default createCheckinModule({ kind: 'skland', ... });
 */

const LOG_CHAR_LIMIT = 300_000;
const LOG_KEEP_CHARS = 200_000;

const STATUS_TEXT = {
  idle: '待签到',
  running: '签到中',
  success: '成功',
  failed: '有失败项',
  cancelled: '已取消',
  error: '执行异常',
  never: '未签到',
};

export function createCheckinModule(options) {
  const config = {
    kind: '',
    title: '签到',
    subtitle: '',
    accent: '#2f6bff',
    accent2: '#6b8bff',
    avatarText: '签',
    loginTitle: '添加账号',
    loginHint: '',
    boards: [],
    ...options,
  };

  /** @type {any} */
  let ctx = null;
  let mounted = false;
  let unsubscribe = null;
  let countdownTimer = null;
  let countdown = 0;
  let pendingDeviceId = '';
  let currentRunId = null;
  let logChars = 0;

  let state = {
    accounts: [],
    settings: { serverChan: { enabled: false, hasKey: false, keyMasked: '', notifyOn: 'always' } },
    security: {},
    running: false,
    /** 本次会话最近一次签到的结果，用于日志区状态徽标 */
    lastStatus: null,
  };

  const refs = {};

  /* ------------------------------------------------------------ 数据同步 */

  function applySnapshot(snapshot) {
    if (!snapshot) return;
    const accounts = (snapshot.accounts && snapshot.accounts[config.kind]) || [];
    state = {
      ...state,
      accounts,
      settings: snapshot.settings || state.settings,
      security: snapshot.security || state.security,
      running: !!(snapshot.running && snapshot.running[config.kind]),
    };
    if (state.running) {
      if (!currentRunId) currentRunId = 'remote';
    } else if (currentRunId === 'remote') {
      currentRunId = null;
    }
    renderAll();
  }

  async function refresh() {
    try {
      const res = await ctx.api.checkin.state();
      if (res && res.ok) applySnapshot(res);
    } catch (err) {
      ctx.toast(`刷新账号状态失败：${err.message}`, 'error');
    }
  }

  /* -------------------------------------------------------------- 渲染 */

  function renderAll() {
    if (!mounted) return;
    renderSummary();
    renderAccounts();
    renderRunButton();
    updateSecurityNotice();
  }

  function renderSummary() {
    const total = state.accounts.length;
    const lastRun = state.accounts
      .map((a) => a.lastRunAt)
      .filter(Boolean)
      .sort()
      .pop();
    const okCount = state.accounts.filter((a) => a.lastRunStatus === 'success').length;
    const failCount = state.accounts.filter((a) => a.lastRunStatus === 'failed').length;

    refs.statTotal.textContent = String(total);
    refs.statOk.textContent = String(okCount);
    refs.statFail.textContent = String(failCount);
    refs.statLast.textContent = ctx.fmtWhen(lastRun);

    const sc = state.settings.serverChan || {};
    const notifyText = !sc.enabled
      ? '已关闭'
      : sc.hasKey
        ? `已开启（${sc.keyMasked}）`
        : '未配置 SendKey';
    refs.notifyState.textContent = notifyText;
    refs.notifyState.className = `pill ${sc.enabled && sc.hasKey ? 'success' : sc.hasKey ? 'warn' : ''}`.trim();

    // 日志区状态徽标：待签到 / 签到中 / 成功 / 有失败项 …
    if (refs.logPill) {
      const status = state.running ? 'running' : state.lastStatus || 'idle';
      refs.logPill.className = `pill ${status === 'idle' ? '' : status}`.trim();
      refs.logPill.textContent = STATUS_TEXT[status] || status;
    }
  }

  function accountStatus(account) {
    if (state.running && refs.activeAccountId === account.id) return 'running';
    if (account.lastRunStatus === 'failed') return 'failed';
    if (account.lastRunStatus === 'success') return 'success';
    return 'idle';
  }

  function renderAccounts() {
    refs.list.replaceChildren();

    if (!state.accounts.length) {
      refs.list.appendChild(
        ctx.el('div', { class: 'ck-empty' }, [
          ctx.el('div', { text: `还没有添加${config.title}账号` }),
          ctx.el('div', {
            text: '在右侧填写手机号并获取短信验证码，登录成功后凭据会自动加密保存在本机。',
          }),
        ])
      );
      return;
    }

    for (const account of state.accounts) {
      const status = accountStatus(account);
      const pill = ctx.el('span', {
        class: `pill ${status === 'idle' ? '' : status}`.trim(),
        text: STATUS_TEXT[status] || status,
      });

      const metaParts = [account.phoneMasked];
      if (account.nickName) metaParts.push(account.nickName);
      if (account.uid) metaParts.push(`UID ${account.uid}`);
      if (account.lastRunAt) metaParts.push(`上次签到 ${ctx.fmtWhen(account.lastRunAt)}`);

      const runBtn = ctx.el('button', { class: 'btn primary small', type: 'button', text: '立即签到' });
      runBtn.disabled = state.running;
      runBtn.addEventListener('click', () => run([account.id]));

      const removeBtn = ctx.el('button', { class: 'btn danger small', type: 'button', text: '删除' });
      removeBtn.addEventListener('click', () => removeAccount(account));

      const boards = ctx.el(
        'div',
        { class: 'ck-chips' },
        (account.boards || []).map((code) =>
          ctx.el('span', { class: 'chip', text: labelOfBoard(code) })
        )
      );

      refs.list.appendChild(
        ctx.el(
          'article',
          { class: 'ck-account', 'data-state': status, 'data-account-id': account.id },
          [
            ctx.el('div', { class: 'ck-account-head' }, [
              ctx.el('div', { class: 'ck-avatar', text: config.avatarText }),
              ctx.el('div', { class: 'ck-account-id' }, [
                ctx.el('strong', { text: account.name || '未命名账号' }),
                ctx.el('div', { class: 'ck-account-meta', text: metaParts.join(' · ') }),
              ]),
              pill,
            ]),
            ctx.el('div', { class: 'ck-account-actions' }, [
              boards,
              ctx.el('span', { class: 'spacer' }),
              runBtn,
              removeBtn,
            ]),
          ]
        )
      );
    }
  }

  function labelOfBoard(code) {
    const found = (config.boards || []).find((b) => b.code === code);
    return found ? found.label : code;
  }

  function renderRunButton() {
    const hasAccounts = state.accounts.length > 0;
    if (refs.runAllBtn) {
      refs.runAllBtn.disabled = !hasAccounts || state.running;
      refs.runAllBtn.title = hasAccounts ? '对全部账号执行一次签到' : '请先添加账号';
    }
    if (refs.cancelBtn) refs.cancelBtn.disabled = !state.running;
    if (refs.headerRunBtn) {
      refs.headerRunBtn.disabled = !hasAccounts || state.running;
    }
  }

  function updateSecurityNotice() {
    if (!refs.securityNotice) return;
    const sec = state.security || {};
    refs.securityNotice.replaceChildren();
    if (sec.available) {
      refs.securityNotice.className = 'notice ok';
      refs.securityNotice.append(
        ctx.el('span', {
          text: `凭据已用系统加密（${sec.backend || 'OS 加密'}）保存在本机，不会写进配置文件和日志。`,
        })
      );
    } else {
      refs.securityNotice.className = 'notice danger';
      refs.securityNotice.append(
        ctx.el('span', {
          text: '当前系统没有提供可用的加密能力，出于安全考虑不会保存任何凭据。',
        })
      );
    }
  }

  /* -------------------------------------------------------------- 日志 */

  function time() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  function openLog() {
    refs.logPanel.hidden = false;
    const empty = refs.logBody.querySelector('.log-empty');
    if (empty) empty.remove();
  }  function appendLog(text, cls) {
    openLog();
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text;
    refs.logBody.appendChild(span);
    logChars += text.length;

    // 超长日志裁剪头部，避免界面变卡（完整记录在日志目录里）
    if (logChars > LOG_CHAR_LIMIT) {
      while (logChars > LOG_KEEP_CHARS && refs.logBody.childNodes.length > 2) {
        const first = refs.logBody.firstChild;
        logChars -= first.textContent.length;
        first.remove();
      }
    }
    refs.logBody.scrollTop = refs.logBody.scrollHeight;
  }

  function clearLog() {
    if (state.running) {
      ctx.toast('签到进行中，结束后再清空日志。', 'warn');
      return;
    }
    refs.logBody.replaceChildren(
      ctx.el('span', {
        class: 'log-empty',
        text: '尚未签到。点击「一键签到」后，过程日志会实时显示在这里。',
      })
    );
    logChars = 0;
    refs.logSize.textContent = '';
  }

  async function copyLog() {
    const text = refs.logBody.innerText || '';
    if (!text.trim()) {
      ctx.toast('当前没有可复制的日志。', 'warn');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      ctx.toast('日志已复制到剪贴板', 'success', 1600);
    } catch (err) {
      ctx.toast(`复制失败：${err.message}`, 'error');
    }
  }

  /* ------------------------------------------------------------ 发送验证码 */

  function startCountdown(seconds = 60) {
    countdown = seconds;
    if (countdownTimer) clearInterval(countdownTimer);
    const tick = () => {
      if (countdown <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        refs.sendCodeBtn.textContent = '发送验证码';
        refs.sendCodeBtn.disabled = false;
        return;
      }
      refs.sendCodeBtn.textContent = `${countdown} 秒后重发`;
      refs.sendCodeBtn.disabled = true;
      countdown--;
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  async function sendCode() {
    const phone = (refs.phoneInput.value || '').trim();
    if (!/^1\d{10}$/.test(phone.replace(/[\s-]/g, ''))) {
      ctx.toast('请输入正确的 11 位手机号', 'warn');
      refs.phoneInput.focus();
      return;
    }
    refs.sendCodeBtn.disabled = true;
    refs.sendCodeBtn.textContent = '发送中…';
    try {
      const res = await ctx.api.checkin.sendCode({ kind: config.kind, phone });
      if (!res || !res.ok) {
        refs.sendCodeBtn.textContent = '发送验证码';
        refs.sendCodeBtn.disabled = false;
        ctx.toast(res?.error || '发送验证码失败', 'error', 6000);
        appendLog(`[发送验证码失败] ${res?.error || '未知错误'}\n`, 'log-err');
        openLog();
        return;
      }
      pendingDeviceId = res.deviceId || '';
      ctx.toast(res.message || '验证码已发送', 'success');
      appendLog(`[${time()}] 已向 ${res.phone || phone} 发送验证码\n`, 'log-meta');
      startCountdown(60);
      refs.codeInput.focus();
    } catch (err) {
      refs.sendCodeBtn.textContent = '发送验证码';
      refs.sendCodeBtn.disabled = false;
      ctx.toast(`发送失败：${err.message}`, 'error', 6000);
    }
  }

  /* ---------------------------------------------------------------- 登录 */

  async function doLogin() {
    const phone = (refs.phoneInput.value || '').trim();
    const code = (refs.codeInput.value || '').trim();
    const name = (refs.nameInput.value || '').trim();
    if (!/^1\d{10}$/.test(phone.replace(/[\s-]/g, ''))) {
      ctx.toast('请输入正确的 11 位手机号', 'warn');
      refs.phoneInput.focus();
      return;
    }
    if (!/^\d{4,8}$/.test(code)) {
      ctx.toast('请输入短信里的数字验证码', 'warn');
      refs.codeInput.focus();
      return;
    }

    refs.loginBtn.disabled = true;
    refs.loginBtn.textContent = '登录中…';
    appendingLogLine(`[${time()}] 正在登录…`);
    try {
      const res = await ctx.api.checkin.login({
        kind: config.kind,
        phone,
        code,
        name,
        deviceId: pendingDeviceId,
      });
      if (!res || !res.ok) {
        ctx.toast(res?.error || '登录失败', 'error', 7000);
        appendLog(`[登录失败] ${res?.error || '未知错误'}\n`, 'log-err');
        return;
      }
      ctx.toast(res.message || '登录成功，凭据已保存', 'success', 4000);
      appendLog(`[${time()}] ${res.message || '登录成功'}\n`, 'log-ok');
      pendingDeviceId = '';
      refs.codeInput.value = '';
      refs.nameInput.value = '';
      if (res.state) applySnapshot(res.state);
      else await refresh();
    } catch (err) {
      ctx.toast(`登录失败：${err.message}`, 'error', 7000);
    } finally {
      refs.loginBtn.disabled = false;
      refs.loginBtn.textContent = '登录并保存凭据';
    }
  }

  function appendingLogLine(text) {
    // 登录日志用灰色，与签到日志区分
    appendLog(text + '\n', 'log-meta');
  }

  /* ------------------------------------------------------------ 签到运行 */

  async function run(accountIds) {
    if (state.running) {
      ctx.toast('签到正在进行中，请稍候。', 'warn');
      return;
    }
    refs.activeAccountId = accountIds && accountIds.length === 1 ? accountIds[0] : null;
    state.running = true;
    state.lastStatus = null;
    renderAll();
    openLog();
    appendLog(`\n── ${time()} 开始签到 ──\n`, 'log-meta');

    try {
      const res = await ctx.api.checkin.run({
        kind: config.kind,
        accountIds: accountIds || [],
      });
      if (!res || !res.ok) {
        state.running = false;
        refs.activeAccountId = null;
        renderAll();
        appendLog(`[无法开始] ${res?.error || '未知错误'}\n`, 'log-err');
        ctx.toast(res?.error || '无法开始签到', 'error', 6000);
        return;
      }
      currentRunId = res.runId;
      refs.cancelBtn.disabled = false;
    } catch (err) {
      state.running = false;
      refs.activeAccountId = null;
      renderAll();
      appendLog(`[调用失败] ${err.message}\n`, 'log-err');
      ctx.toast(`调用失败：${err.message}`, 'error');
    }
  }

  async function cancelRun() {
    if (!currentRunId) return;
    refs.cancelBtn.disabled = true;
    appendLog(`[${time()}] 正在请求取消…\n`, 'log-warn');
    const res = await ctx.api.checkin.cancel(currentRunId);
    if (res && res.ok === false) {
      ctx.toast(res.error || '取消失败', 'warn');
      refs.cancelBtn.disabled = false;
    }
  }

  async function removeAccount(account) {
    const res = await ctx.api.confirm({
      title: '删除账号',
      message: `确认删除「${account.name || '未命名账号'}」吗？`,
      detail: `删除后本地保存的${config.title}凭据会被清除，需要重新用手机号登录才能签到。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!res.ok) return;
    const removed = await ctx.api.checkin.removeAccount({ kind: config.kind, id: account.id });
    if (!removed.ok) {
      ctx.toast(removed.error || '删除失败', 'error');
      return;
    }
    ctx.toast('账号已删除', 'success', 2000);
    if (removed.state) applySnapshot(removed.state);
    else await refresh();
  }

  /* ------------------------------------------------------------ 事件处理 */

  function handleEvent(evt) {
    if (!evt || evt.kind !== config.kind) return;

    switch (evt.type) {
      case 'start': {
        state.running = true;
        state.lastStatus = null;
        currentRunId = evt.runId;
        refs.logSize.textContent = '';
        renderAll();
        break;
      }
      case 'log': {
        const cls = {
          ok: 'log-ok',
          err: 'log-err',
          warn: 'log-warn',
          step: 'log-step',
          info: 'log-meta',
        }[evt.level];
        appendLog(`${evt.text}\n`, cls);
        break;
      }
      case 'account-start': {
        refs.activeAccountId = evt.accountId;
        renderAccounts();
        break;
      }
      case 'account-end': {
        refs.activeAccountId = null;
        refresh();
        break;
      }
      case 'notify': {
        if (evt.ok) appendLog(`[微信推送] 已发送（${evt.host || ''}）\n`, 'log-ok');
        else appendLog(`[微信推送失败] ${evt.error || '未知错误'}\n`, 'log-err');
        break;
      }
      case 'exit': {
        state.running = false;
        state.lastStatus = evt.status || 'failed';
        currentRunId = null;
        refs.activeAccountId = null;
        const counts = evt.counts || { success: 0, already: 0, fail: 0, skip: 0 };
        const summary = `成功 ${counts.success} · 已签 ${counts.already} · 失败 ${counts.fail} · 跳过 ${counts.skip}`;
        const cls = evt.status === 'success' ? 'log-ok' : evt.status === 'cancelled' ? 'log-warn' : 'log-err';
        appendLog(
          `── ${time()} 结束：${STATUS_TEXT[evt.status] || evt.status}（${summary}），耗时 ${ctx.fmtTime(evt.durationMs || 0)} ──\n`,
          cls
        );
        if (evt.errorMessage) appendLog(`${evt.errorMessage}\n`, 'log-err');
        refs.logSize.textContent = `${counts.success + counts.already + counts.fail + counts.skip} 条结果`;
        refresh();
        if (evt.status === 'failed') {
          ctx.toast(`${config.title}签到有失败项：${counts.fail} 条，详情见日志`, 'error', 6000);
        } else if (evt.status === 'success') {
          ctx.toast(`${config.title}签到完成：${summary}`, 'success', 4000);
        } else if (evt.status === 'cancelled') {
          ctx.toast('签到已取消', 'warn');
        } else if (evt.status === 'error') {
          ctx.toast(evt.errorMessage || '签到异常结束', 'error', 6000);
        }
        break;
      }
      default:
        break;
    }
  }

  /* ------------------------------------------------------------ 页面构建 */

  function buildLoginCard() {
    const phoneInput = ctx.el('input', {
      class: 'input',
      type: 'tel',
      inputmode: 'numeric',
      maxlength: '11',
      placeholder: '11 位手机号',
      autocomplete: 'off',
    });
    const codeInput = ctx.el('input', {
      class: 'input',
      type: 'text',
      inputmode: 'numeric',
      maxlength: '8',
      placeholder: '短信验证码',
      autocomplete: 'off',
    });
    const nameInput = ctx.el('input', {
      class: 'input',
      type: 'text',
      maxlength: '24',
      placeholder: '备注名（可留空，默认取角色名）',
    });
    const sendCodeBtn = ctx.el('button', {
      class: 'btn',
      type: 'button',
      text: '发送验证码',
    });
    const loginBtn = ctx.el('button', {
      class: 'btn primary',
      type: 'button',
      text: '登录并保存凭据',
    });
    loginBtn.style.width = '100%';
    loginBtn.style.justifyContent = 'center';

    sendCodeBtn.addEventListener('click', sendCode);
    loginBtn.addEventListener('click', doLogin);
    phoneInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendCode();
    });
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLogin();
    });

    const securityNotice = ctx.el('div', { class: 'notice' });
    refs.securityNotice = securityNotice;

    const card = ctx.el('section', { class: 'card' }, [
      ctx.el('h2', { text: config.loginTitle }),
      ctx.el('div', { class: 'field' }, [
        ctx.el('label', { text: '手机号', for: '' }),
        phoneInput,
      ]),
      ctx.el('div', { class: 'field' }, [
        ctx.el('span', { class: 'field-label', text: '短信验证码' }),
        ctx.el('div', { class: 'input-group' }, [codeInput, sendCodeBtn]),
      ]),
      ctx.el('div', { class: 'field' }, [
        ctx.el('span', { class: 'field-label', text: '备注名（可选）' }),
        nameInput,
      ]),
      loginBtn,
      ctx.el('p', { class: 'hint', style: 'margin:10px 0 12px;font-size:11.5px;color:#8a94a6;line-height:1.6', text: config.loginHint }),
      securityNotice,
    ]);

    refs.phoneInput = phoneInput;
    refs.codeInput = codeInput;
    refs.nameInput = nameInput;
    refs.sendCodeBtn = sendCodeBtn;
    refs.loginBtn = loginBtn;
    return card;
  }

  function buildLogPanel() {
    const logBody = ctx.el('pre', { class: 'log-body' }, [
      ctx.el('span', { class: 'log-empty', text: '尚未签到。点击「一键签到」后，过程日志会实时显示在这里。' }),
    ]);
    const logSize = ctx.el('span', { class: 'muted', text: '' });
    const pill = ctx.el('span', { class: 'pill', text: '待签到' });
    const copyBtn = ctx.el('button', { type: 'button', text: '复制' });
    const clearBtn = ctx.el('button', { type: 'button', text: '清空' });

    copyBtn.addEventListener('click', copyLog);
    clearBtn.addEventListener('click', clearLog);

    const head = ctx.el('div', { class: 'log-head' }, [
      ctx.el('span', { class: 'log-title', text: '签到日志' }),
      pill,
      logSize,
      ctx.el('span', { class: 'spacer' }),
      copyBtn,
      clearBtn,
    ]);
    // 日志面板常驻显示：签到是这个页面最重要的反馈，藏起来反而让人找不到
    const panel = ctx.el('div', { class: 'log-panel' }, [head, logBody]);

    refs.logPanel = panel;
    refs.logBody = logBody;
    refs.logSize = logSize;
    refs.logPill = pill;
    return panel;
  }

  function buildSummary() {
    const statTotal = ctx.el('b', { text: '0' });
    const statOk = ctx.el('b', { text: '0' });
    const statFail = ctx.el('b', { text: '0' });
    const statLast = ctx.el('b', { text: '—', style: 'font-size:14px;font-weight:600' });
    const notifyState = ctx.el('span', { class: 'pill', text: '—' });

    const runAllBtn = ctx.el('button', {
      class: 'btn primary',
      type: 'button',
      text: '一键签到',
    });
    const cancelBtn = ctx.el('button', { class: 'btn', type: 'button', text: '取消' });
    runAllBtn.addEventListener('click', () => run([]));
    cancelBtn.addEventListener('click', cancelRun);
    cancelBtn.disabled = true;

    refs.statTotal = statTotal;
    refs.statOk = statOk;
    refs.statFail = statFail;
    refs.statLast = statLast;
    refs.notifyState = notifyState;
    refs.runAllBtn = runAllBtn;
    refs.cancelBtn = cancelBtn;

    return ctx.el('section', { class: 'card ck-summary' }, [
      ctx.el('div', { class: 'ck-stats' }, [
        ctx.el('div', { class: 'stat' }, [statTotal, ctx.el('span', { text: '账号数' })]),
        ctx.el('div', { class: 'stat' }, [statOk, ctx.el('span', { text: '上次成功' })]),
        ctx.el('div', { class: 'stat' }, [statFail, ctx.el('span', { text: '上次失败' })]),
        ctx.el('div', { class: 'stat' }, [statLast, ctx.el('span', { text: '最近签到时间' })]),
        ctx.el('div', { class: 'stat' }, [notifyState, ctx.el('span', { text: '微信推送' })]),
      ]),
      ctx.el('div', { class: 'ck-summary-actions' }, [
        ctx.el('span', { class: 'muted', text: '签到结果会写入日志目录，可随时回查' }),
        ctx.el('span', { class: 'spacer' }),
        cancelBtn,
        runAllBtn,
      ]),
    ]);
  }

  function updateHeader() {
    const total = state.accounts.length;
    ctx.setHeader({
      title: config.title,
      description:
        total > 0
          ? `${config.subtitle} · 已添加 ${total} 个账号，凭据加密保存在本机`
          : `${config.subtitle} · 先用手机号 + 验证码添加账号`,
      actions: [
        {
          label: '一键签到',
          variant: 'primary',
          onClick: () => run([]),
          title: '对全部账号各执行一次签到',
        },
      ],
    });
  }

  /* ------------------------------------------------------------ 模块导出 */

  return {
    async mount(root, moduleCtx) {
      ctx = moduleCtx;
      mounted = true;
      unsubscribe?.();
      unsubscribe = ctx.api.checkin.onEvent(handleEvent);

      root.replaceChildren();
      root.style.setProperty('--ck-accent', config.accent);
      root.style.setProperty('--ck-accent-2', config.accent2);

      const summary = buildSummary();
      const list = ctx.el('div', { class: 'ck-list' });
      const logPanel = buildLogPanel();
      refs.list = list;

      const mainCol = ctx.el('div', { class: 'ck-main' }, [summary, list, logPanel]);
      const sideCol = ctx.el('div', { class: 'ck-side' }, [buildLoginCard()]);
      root.appendChild(ctx.el('div', { class: 'ck-layout' }, [mainCol, sideCol]));

      applySnapshot(ctx.boot?.checkin);
      await refresh();
      updateHeader();
    },

    async unmount() {
      mounted = false;
      unsubscribe?.();
      unsubscribe = null;
      if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }
      currentRunId = null;
    },

    updateHeader,

    async onConfigChanged(moduleCtx, boot) {
      ctx = moduleCtx;
      if (boot?.checkin) applySnapshot(boot.checkin);
      updateHeader();
    },
  };
}

export default { createCheckinModule };
