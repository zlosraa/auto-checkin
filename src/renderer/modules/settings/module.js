'use strict';

/**
 * settings — 设置与诊断
 *
 * 三块内容：
 *   1. Server酱 微信推送（SendKey 只存在本地加密文件里，界面上只显示脱敏值）
 *   2. 凭据安全与存储位置（加密后端、文件路径、一键清空）
 *   3. 运行环境体检（配置目录、脚本是否存在、日志目录）
 */

let ctx = null;
let refs = {};
let snapshot = {
  accounts: { skland: [], miyoushe: [] },
  settings: { serverChan: { enabled: false, hasKey: false, keyMasked: '', notifyOn: 'always' } },
  security: {},
};

/* ------------------------------------------------------------ 微信推送卡片 */

function buildNotifyCard() {
  const { el } = ctx;

  const enabledInput = el('input', { type: 'checkbox' });
  const keyInput = el('input', {
    class: 'input',
    type: 'password',
    placeholder: '粘贴 Server酱 SendKey（sctp… 或 SCT…）',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const notifySelect = el('select', { class: 'select' }, [
    el('option', { value: 'always', text: '每次签到都推送' }),
    el('option', { value: 'failure', text: '只在有失败项时推送' }),
    el('option', { value: 'never', text: '不推送' }),
  ]);

  const saveBtn = el('button', { class: 'btn primary', type: 'button', text: '保存推送设置' });
  const testBtn = el('button', { class: 'btn', type: 'button', text: '发送测试推送' });
  const clearKeyBtn = el('button', { class: 'btn subtle', type: 'button', text: '清除已保存的 SendKey' });
  const keyState = el('div', { class: 'notice' });

  refs.enabledInput = enabledInput;
  refs.keyInput = keyInput;
  refs.notifySelect = notifySelect;
  refs.keyState = keyState;
  refs.testBtn = testBtn;
  refs.clearKeyBtn = clearKeyBtn;

  saveBtn.addEventListener('click', async () => {
    const typed = keyInput.value.trim();
    const payload = {
      enabled: enabledInput.checked,
      notifyOn: notifySelect.value,
    };
    if (typed) {
      payload.sendKey = typed;
      payload.keepKey = false;
    } else {
      payload.keepKey = true; // 没输入就保留原有 key，避免误清空
    }
    saveBtn.disabled = true;
    try {
      const res = await ctx.api.checkin.saveSettings({ serverChan: payload });
      if (!res || !res.ok) {
        ctx.toast(res?.error || '保存失败', 'error', 6000);
        return;
      }
      if (res.state) applySnapshot(res.state);
      keyInput.value = '';
      ctx.toast('推送设置已保存', 'success');
    } finally {
      saveBtn.disabled = false;
    }
  });

  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testBtn.textContent = '发送中…';
    try {
      const res = await ctx.api.checkin.testNotify();
      if (res && res.ok) ctx.toast(res.message || '测试推送已发送', 'success', 5000);
      else ctx.toast(res?.error || '测试推送失败', 'error', 7000);
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = '发送测试推送';
    }
  });

  clearKeyBtn.addEventListener('click', async () => {
    const confirm = await ctx.api.confirm({
      title: '清除 SendKey',
      message: '确认清除本机保存的 Server酱 SendKey 吗？',
      detail: '清除后签到结果不再推送到微信，可随时重新填写。',
      confirmLabel: '清除',
      danger: true,
    });
    if (!confirm.ok) return;
    const res = await ctx.api.checkin.saveSettings({ serverChan: { sendKey: '', keepKey: false } });
    if (res && res.ok) {
      if (res.state) applySnapshot(res.state);
      ctx.toast('SendKey 已清除', 'success');
    } else {
      ctx.toast(res?.error || '清除失败', 'error');
    }
  });

  return el('section', { class: 'card' }, [
    el('div', { class: 'settings-card-head' }, [
      el('h2', { text: '微信推送（Server酱）' }),
      el('span', { class: 'muted', text: '签到结束后推送结果到微信' }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'switch' }, [enabledInput, el('span', { text: '启用 Server酱 推送' })]),
    ]),
    el('div', { class: 'field' }, [
      el('label', { text: 'SendKey' }),
      keyInput,
      el('span', {
        class: 'hint',
        text: '在 sct.ftqq.com 登录后复制 SendKey。留空保存 = 保留原值；SendKey 只会加密保存在本机，不会写进配置文件。',
      }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { text: '推送时机' }),
      notifySelect,
    ]),
    keyState,
    el('div', { class: 'settings-actions' }, [saveBtn, testBtn, clearKeyBtn]),
  ]);
}

/* ------------------------------------------------------------ 凭据安全卡片 */

function buildSecurityCard() {
  const { el } = ctx;
  const detail = el('dl', { class: 'kv' });
  refs.securityDetail = detail;

  const openDirBtn = el('button', { class: 'btn', type: 'button', text: '打开凭据目录' });
  const clearBtn = el('button', { class: 'btn danger', type: 'button', text: '清空全部凭据与设置' });

  openDirBtn.addEventListener('click', async () => {
    const dir = snapshot.security?.dir;
    if (!dir) return;
    const res = await ctx.api.openPath(dir);
    if (res && res.ok === false) ctx.toast(res.error, 'error');
  });

  clearBtn.addEventListener('click', async () => {
    const confirm = await ctx.api.confirm({
      title: '清空全部凭据',
      message: '确认删除本机保存的所有账号凭据、SendKey 与设置吗？',
      detail: '此操作不可撤销。删除后需要重新用手机号登录才能签到，Server酱 SendKey 也需要重新填写。',
      confirmLabel: '全部清空',
      danger: true,
    });
    if (!confirm.ok) return;
    const res = await ctx.api.checkin.clearAll();
    if (res && res.ok) {
      if (res.state) applySnapshot(res.state);
      ctx.toast('已清空全部凭据与设置', 'success');
    } else {
      ctx.toast(res?.error || '清空失败', 'error');
    }
  });

  refs.openDirBtn = openDirBtn;

  return el('section', { class: 'card' }, [
    el('div', { class: 'settings-card-head' }, [
      el('h2', { text: '凭据与安全' }),
      el('span', { class: 'muted', text: '敏感信息只在本机加密保存' }),
    ]),
    detail,
    el('div', { class: 'settings-actions' }, [openDirBtn, clearBtn]),
  ]);
}

/* ------------------------------------------------------------ 运行环境卡片 */

function buildEnvCard() {
  const { el } = ctx;
  const detail = el('dl', { class: 'kv' });
  refs.envDetail = detail;

  const reloadBtn = el('button', { class: 'btn', type: 'button', text: '重新加载配置' });
  const openConfigBtn = el('button', { class: 'btn', type: 'button', text: '打开配置目录' });
  const openLogBtn = el('button', { class: 'btn', type: 'button', text: '打开日志目录' });

  reloadBtn.addEventListener('click', async () => {
    const res = await ctx.api.reloadConfig();
    if (res?.boot) {
      ctx.toast(res.message || '配置已重新加载', 'success');
      renderEnv();
    }
  });
  openConfigBtn.addEventListener('click', () => ctx.api.openConfigDir());
  openLogBtn.addEventListener('click', () => ctx.api.openLogDir());

  return el('section', { class: 'card' }, [
    el('div', { class: 'settings-card-head' }, [
      el('h2', { text: '运行环境' }),
      el('span', { class: 'muted', text: '配置文件位置与版本信息' }),
    ]),
    detail,
    el('div', { class: 'settings-actions' }, [reloadBtn, openConfigBtn, openLogBtn]),
  ]);
}

/* ------------------------------------------------------------ 体检卡片 */

function buildDiagCard() {
  const { el } = ctx;
  const list = el('div', { class: 'diag-list' });
  refs.diagList = list;
  const refreshBtn = el('button', { class: 'btn', type: 'button', text: '重新体检' });
  refreshBtn.addEventListener('click', () => runDiagnose());

  return el('section', { class: 'card' }, [
    el('div', { class: 'settings-card-head' }, [
      el('h2', { text: '脚本体检' }),
      el('span', { class: 'muted', text: '检查每个工具的脚本与工作目录是否还在' }),
    ]),
    list,
    el('div', { class: 'settings-actions' }, [refreshBtn]),
  ]);
}

/* -------------------------------------------------------------- 渲染逻辑 */

function kv(dl, pairs) {
  const { el } = ctx;
  dl.replaceChildren();
  for (const [key, value, title] of pairs) {
    const dd = el('dd', { text: value == null || value === '' ? '—' : String(value) });
    if (title) dd.title = title;
    dl.append(el('dt', { text: key }), dd);
  }
}

function applySnapshot(next) {
  if (!next) return;
  snapshot = { ...snapshot, ...next };
  const sc = snapshot.settings?.serverChan || {};
  if (refs.enabledInput) {
    refs.enabledInput.checked = !!sc.enabled;
    refs.notifySelect.value = sc.notifyOn || 'always';
    refs.keyInput.placeholder = sc.hasKey
      ? `已保存：${sc.keyMasked}（留空表示不修改）`
      : '粘贴 Server酱 SendKey（sctp… 或 SCT…）';
  }
  if (refs.keyState) {
    refs.keyState.replaceChildren();
    if (!sc.hasKey) {
      refs.keyState.className = 'notice warn';
      refs.keyState.append(
        ctx.el('span', { text: '还没有配置 SendKey，签到结果不会推送到微信。' })
      );
    } else if (!sc.enabled) {
      refs.keyState.className = 'notice';
      refs.keyState.append(ctx.el('span', { text: `已保存 SendKey（${sc.keyMasked}），但推送开关是关闭的。` }));
    } else {
      refs.keyState.className = 'notice ok';
      refs.keyState.append(
        ctx.el('span', {
          text:
            `已配置 SendKey（${sc.keyMasked}），推送时机：` +
            ({ always: '每次签到都推送', failure: '只在有失败项时推送', never: '不推送' }[sc.notifyOn] ||
              sc.notifyOn),
        })
      );
    }
  }
  if (refs.clearKeyBtn) refs.clearKeyBtn.disabled = !sc.hasKey;
  if (refs.testBtn) refs.testBtn.disabled = !sc.hasKey;

  renderSecurity();
  renderEnv();
}

function renderSecurity() {
  if (!refs.securityDetail) return;
  const sec = snapshot.security || {};
  const counts = sec.counts || {};
  kv(refs.securityDetail, [
    ['加密方式', sec.available ? sec.backend : '不可用（不会保存凭据）'],
    ['凭据文件', sec.file, sec.file],
    ['文件状态', sec.exists ? '已存在' : '尚未创建（首次登录时生成）'],
    ['已保存账号', `森空岛 ${counts.skland || 0} 个 · 米游社 ${counts.miyoushe || 0} 个`],
  ]);
}

function renderEnv() {
  if (!refs.envDetail) return;
  const boot = ctx.boot;
  const cfg = boot.config;
  const sourceLabel = {
    env: '环境变量指定',
    portable: 'exe 同级目录',
    exe: '程序目录',
    userdata: '用户数据目录',
    bundled: '内置只读配置',
  }[cfg.source] || cfg.source;

  kv(refs.envDetail, [
    ['版本', `${boot.app.name} ${boot.app.version}`],
    ['运行内核', `Electron ${boot.app.env.electron} / Chromium ${boot.app.env.chrome}`],
    ['配置目录', cfg.dir, cfg.toolsFile],
    ['配置来源', `${sourceLabel}${cfg.writable ? '（可写）' : '（只读，界面内改配置会被拒绝）'}`],
    ['tools.json', cfg.toolsFile, cfg.toolsFile],
    ['modules.json', cfg.modulesFile, cfg.modulesFile],
  ]);
}

async function runDiagnose() {
  if (!refs.diagList) return;
  const { el } = ctx;
  refs.diagList.replaceChildren(el('div', { class: 'muted', text: '正在体检…' }));
  try {
    const res = await ctx.api.diagnose();
    if (!res || !res.ok) throw new Error(res?.error || '体检失败');
    refs.diagList.replaceChildren();
    if (!res.items.length) {
      refs.diagList.append(el('div', { class: 'muted', text: '还没有配置任何脚本工具。' }));
      return;
    }
    for (const item of res.items) {
      const ok = item.scriptExists && item.cwdExists && !item.problems.length;
      const flag = el('span', {
        class: 'diag-flag',
        style: `color:${ok ? 'var(--ok)' : 'var(--danger)'}`,
        text: ok ? '正常' : '有问题',
      });
      const problems = el(
        'div',
        { class: 'diag-path' },
        (item.problems || []).map((p) => el('div', { text: p }))
      );
      refs.diagList.append(
        el('div', { class: 'diag-item' }, [
          el('div', { style: 'min-width:0;flex:1' }, [
            el('div', { class: 'diag-name', text: item.name }),
            el('div', { class: 'diag-path', text: item.scriptPath || '（未配置）' }),
            el('div', { class: 'diag-path', text: `工作目录：${item.cwd || '（默认）'}` }),
            (item.problems || []).length ? problems : null,
          ]),
          flag,
        ])
      );
    }
  } catch (err) {
    refs.diagList.replaceChildren(el('div', { class: 'notice danger' }, [el('span', { text: err.message })]));
  }
}

function updateHeader() {
  ctx.setHeader({
    title: '设置与诊断',
    description: '推送配置、凭据加密状态、脚本体检——敏感信息都只保存在本机',
    actions: [
      { label: '打开日志目录', onClick: () => ctx.api.openLogDir() },
    ],
  });
}

export default {
  async mount(root, moduleCtx) {
    ctx = moduleCtx;
    root.replaceChildren();

    const { el } = ctx;
    const notifyCard = buildNotifyCard();
    const securityCard = buildSecurityCard();
    const envCard = buildEnvCard();
    const diagCard = buildDiagCard();

    root.append(el('div', { class: 'settings-grid' }, [notifyCard, securityCard, envCard, diagCard]));

    if (ctx.boot?.checkin) applySnapshot(ctx.boot.checkin);
    try {
      const res = await ctx.api.checkin.state();
      if (res && res.ok) applySnapshot(res);
    } catch {
      /* 状态读取失败时保留启动数据 */
    }
    updateHeader();
    runDiagnose();
  },

  async unmount() {
    refs = {};
    ctx = null;
  },

  updateHeader,

  async onConfigChanged(moduleCtx, boot) {
    ctx = moduleCtx;
    if (boot?.checkin) applySnapshot(boot.checkin);
    renderEnv();
    updateHeader();
  },
};
