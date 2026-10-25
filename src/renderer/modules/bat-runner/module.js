'use strict';

/**
 * bat-runner — 脚本工具模块
 *
 * 一个「插件」的标准形态：
 *   export default { mount(root, ctx), unmount(), onConfigChanged(ctx, boot), updateHeader(ctx) }
 * 模块只通过 ctx.api 里暴露的 IPC 与系统交互，不直接碰 Node / fs。
 *
 * 工具清单完全来自 config/tools.json（由主进程校验后通过 ctx.boot.tools 传入），
 * 本文件里没有任何写死的脚本路径或工具名称。
 * 界面上的「新增 / 编辑 / 删除」会写回 tools.json（主进程自动备份原文件）。
 */

const STATUS_TEXT = {
  idle: '待运行',
  running: '运行中',
  success: '成功',
  failed: '失败',
  timeout: '已超时',
  cancelled: '已中止',
  error: '执行异常',
  'config-error': '配置异常',
};

const LOG_CHAR_LIMIT = 400_000;
const LOG_KEEP_CHARS = 300_000;

let ctx = null;
let gridEl = null;
let countEl = null;
let emptyEl = null;
let toolbarInput = null;
let unsubscribe = null;
let ticker = null;
let modalEl = null;
/** toolId -> card */
let cards = new Map();

/* ------------------------------------------------------------------ 小工具 */

const time = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

function labelFor(tool) {
  if (!tool.timeoutMs) return '不限';
  const sec = Math.round(tool.timeoutMs / 1000);
  return sec >= 60 ? `${Math.round(sec / 60)} 分钟` : `${sec} 秒`;
}

/** 从原始配置里找某个 tool 的原始条目（编辑时要用，避免把归一化字段写回文件） */
function rawToolById(id) {
  const list = ctx.boot?.rawTools || [];
  return list.find((item) => item && item.id === id) || null;
}

/* ------------------------------------------------------------------ 卡片 */

function createCard(tool) {
  const { el } = ctx;

  const pill = el('span', { class: 'pill', text: STATUS_TEXT.idle });
  const title = el('h3', { text: tool.name });
  const desc = el('p', { class: 'tool-desc', text: tool.description || '（无说明）' });

  const scriptVal = el('code', { class: 'meta-val', text: tool.scriptPath || '（未配置）' });
  scriptVal.title = tool.scriptPath || '';
  const cwdVal = el('code', { class: 'meta-val', text: tool.cwd || '（默认：脚本所在目录）' });
  cwdVal.title = tool.cwd || '';
  const timeoutVal = el('span', { class: 'meta-val', text: labelFor(tool) });

  const revealBtn = el('button', {
    class: 'btn subtle',
    type: 'button',
    text: '定位',
    title: '在资源管理器中选中该脚本',
  });
  const openCwdBtn = el('button', {
    class: 'btn subtle',
    type: 'button',
    text: '打开目录',
    title: '打开工作目录',
  });

  const tags = el(
    'div',
    { class: 'tag-chips' },
    (tool.tags || []).map((t) => el('span', { class: 'tag', text: t }))
  );

  const problemList = el(
    'ul',
    { class: 'problem-list' },
    (tool.problems || []).map((p) => el('li', { text: p }))
  );

  const runBtn = el('button', { class: 'btn primary', type: 'button' });
  runBtn.innerHTML = `${ctx.icon('bolt')}<span>运行</span>`;
  const cancelBtn = el('button', { class: 'btn danger', type: 'button', text: '中止' });
  const editBtn = el('button', { class: 'btn subtle', type: 'button', text: '编辑' });
  const copyBtn = el('button', { class: 'btn subtle', type: 'button', text: '复制日志' });
  const clearBtn = el('button', { class: 'btn subtle', type: 'button', text: '清空' });
  const metrics = el('span', { class: 'run-metrics' });

  const logTitle = el('span', { class: 'log-title', text: '运行输出' });
  const logSize = el('span', { class: 'muted', text: '' });
  const jumpBtn = el('button', { type: 'button', text: '跳到最新' });
  const logBody = el('pre', { class: 'log-body' });
  logBody.appendChild(
    el('span', {
      class: 'log-empty',
      text: '尚未运行。点击「运行」后，标准输出与错误信息会实时显示在这里。',
    })
  );

  const logHead = el('div', { class: 'log-head' }, [logTitle, logSize, el('span', { class: 'spacer' }), jumpBtn]);
  const logPanel = el('div', { class: 'log-panel', hidden: true }, [logHead, logBody]);

  const node = el('article', { class: 'tool-card', 'data-tool-card': true, 'data-tool-id': tool.id }, [
    el('div', { class: 'tool-card-body' }, [
      el('div', { class: 'tool-head' }, [el('div', {}, [title, desc]), pill]),
      el('div', { class: 'tool-meta' }, [
        el('div', { class: 'meta-row' }, [el('span', { class: 'meta-key', text: '脚本' }), scriptVal, revealBtn]),
        el('div', { class: 'meta-row' }, [el('span', { class: 'meta-key', text: '工作目录' }), cwdVal, openCwdBtn]),
        el('div', { class: 'meta-row' }, [el('span', { class: 'meta-key', text: '超时' }), timeoutVal]),
      ]),
      (tool.tags || []).length ? tags : null,
      (tool.problems || []).length ? problemList : null,
    ]),
    el('div', { class: 'tool-actions' }, [
      runBtn,
      cancelBtn,
      el('span', { class: 'spacer' }),
      metrics,
      editBtn,
      copyBtn,
      clearBtn,
    ]),
    logPanel,
  ]);

  const card = {
    tool,
    node,
    refs: {
      pill,
      title,
      desc,
      scriptVal,
      cwdVal,
      timeoutVal,
      runBtn,
      cancelBtn,
      editBtn,
      copyBtn,
      clearBtn,
      metrics,
      logPanel,
      logBody,
      logSize,
      revealBtn,
      openCwdBtn,
    },
    status: tool.ready ? 'idle' : 'config-error',
    runId: null,
    startedAt: 0,
    logChars: 0,
    autoScroll: true,
    trimmed: false,
  };

  cancelBtn.disabled = true;

  runBtn.addEventListener('click', () => startRun(card));
  cancelBtn.addEventListener('click', () => cancelRun(card));
  editBtn.addEventListener('click', () => openEditor(card.tool.id));
  copyBtn.addEventListener('click', () => copyLog(card));
  clearBtn.addEventListener('click', () => clearLog(card));
  jumpBtn.addEventListener('click', () => {
    card.autoScroll = true;
    logBody.scrollTop = logBody.scrollHeight;
  });
  revealBtn.addEventListener('click', async () => {
    const res = await ctx.api.revealPath(card.tool.scriptPath);
    if (res && res.ok === false) ctx.toast(res.error, 'error');
  });
  openCwdBtn.addEventListener('click', async () => {
    const res = await ctx.api.openPath(card.tool.cwd || card.tool.scriptPath);
    if (res && res.ok === false) ctx.toast(res.error, 'error');
  });
  logBody.addEventListener('scroll', () => {
    const distance = logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight;
    card.autoScroll = distance < 48;
  });

  setStatus(card, card.status);
  applyToolState(card, tool);
  return card;
}

/** 配置热更新时，把最新的工具字段刷到已有卡片上（保留日志） */
function applyToolState(card, tool) {
  card.tool = tool;
  card.refs.title.textContent = tool.name;
  card.refs.desc.textContent = tool.description || '（无说明）';
  card.refs.scriptVal.textContent = tool.scriptPath || '（未配置）';
  card.refs.scriptVal.title = tool.scriptPath || '';
  card.refs.cwdVal.textContent = tool.cwd || '（默认：脚本所在目录）';
  card.refs.cwdVal.title = tool.cwd || '';
  card.refs.timeoutVal.textContent = labelFor(tool);

  const running = card.status === 'running';
  if (!tool.ready) {
    card.refs.runBtn.disabled = true;
    card.refs.runBtn.title = tool.problems?.[0] || '配置有误';
  } else if (!running) {
    card.refs.runBtn.disabled = false;
    card.refs.runBtn.title = '';
  }
  if (!running) {
    const nextStatus = !tool.ready ? 'config-error' : card.status === 'config-error' ? 'idle' : card.status;
    setStatus(card, nextStatus);
  }
}

/* -------------------------------------------------------------- 状态/输出 */

function setStatus(card, status) {
  card.status = status;
  const pill = card.refs.pill;
  pill.className = `pill ${status === 'idle' ? '' : status}`.trim();
  pill.textContent = STATUS_TEXT[status] || status;
  card.node.dataset.state = status;
}

function writeLine(card, text, cls) {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  card.refs.logBody.appendChild(span);
  card.logChars += text.length;
  trimLog(card);
  scrollLog(card);
}

function trimLog(card) {
  if (card.logChars <= LOG_CHAR_LIMIT) return;
  const body = card.refs.logBody;
  while (card.logChars > LOG_KEEP_CHARS && body.childNodes.length > 2) {
    const first = body.firstChild;
    card.logChars -= first.textContent.length;
    first.remove();
  }
  if (!card.trimmed) {
    card.trimmed = true;
    const notice = document.createElement('span');
    notice.className = 'log-warn';
    notice.textContent = '[较早的输出已折叠，可用「复制日志」或查看日志目录获取完整记录]\n';
    body.insertBefore(notice, body.firstChild);
  }
}

function scrollLog(card) {
  if (!card.autoScroll) return;
  const body = card.refs.logBody;
  body.scrollTop = body.scrollHeight;
}

function openLog(card) {
  card.refs.logPanel.hidden = false;
  const empty = card.refs.logBody.querySelector('.log-empty');
  if (empty) empty.remove();
}

function clearLog(card) {
  if (card.status === 'running') {
    ctx.toast('脚本正在运行，结束后再清空。', 'warn');
    return;
  }
  card.refs.logBody.replaceChildren();
  card.logChars = 0;
  card.trimmed = false;
  card.refs.logSize.textContent = '';
  card.refs.metrics.textContent = '';
  card.refs.logPanel.hidden = true;
}

async function copyLog(card) {
  const text = card.refs.logBody.innerText || '';
  if (!text.trim()) {
    ctx.toast('当前没有可复制的日志。', 'warn');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    ctx.toast('日志已复制到剪贴板', 'success', 1800);
  } catch (err) {
    ctx.toast(`复制失败：${err.message}`, 'error');
  }
}

/* -------------------------------------------------------------- 执行控制 */

async function startRun(card) {
  const tool = card.tool;
  if (card.status === 'running') return;
  card.refs.runBtn.disabled = true;
  card.refs.cancelBtn.disabled = true; // 拿到 runId 后启用
  openLog(card);
  setStatus(card, 'running');
  card.startedAt = Date.now();
  card.refs.metrics.textContent = '正在启动…';

  try {
    const res = await ctx.api.runTool(tool.id);
    if (!res || res.ok !== true) {
      setStatus(card, 'error');
      card.refs.runBtn.disabled = !tool.ready;
      card.refs.metrics.textContent = '';
      writeLine(card, `[无法执行] ${(res && res.error) || '未知错误'}\n`, 'log-err');
      ctx.toast((res && res.error) || '无法执行该工具', 'error', 4500);
      return;
    }
    card.runId = res.runId;
    card.refs.cancelBtn.disabled = false;
    if (res.tool) applyToolState(card, res.tool);
  } catch (err) {
    setStatus(card, 'error');
    card.refs.runBtn.disabled = false;
    card.refs.metrics.textContent = '';
    writeLine(card, `[调用失败] ${err.message}\n`, 'log-err');
    ctx.toast(`调用失败：${err.message}`, 'error', 4500);
  }
}

async function cancelRun(card) {
  if (!card.runId) return;
  card.refs.cancelBtn.disabled = true;
  writeLine(card, '[操作] 正在请求中止…\n', 'log-warn');
  const res = await ctx.api.cancelRun(card.runId);
  if (res && res.ok === false) {
    ctx.toast(res.error || '中止失败', 'warn');
    card.refs.cancelBtn.disabled = false;
  }
}

/* ------------------------------------------------------------ 事件分发 */

function handleRunEvent(evt) {
  if (!evt || !evt.toolId) return;
  const card = cards.get(evt.toolId);
  if (!card) return;

  switch (evt.type) {
    case 'start': {
      card.runId = evt.runId;
      card.startedAt = evt.startedAt || Date.now();
      card.refs.cancelBtn.disabled = false;
      openLog(card);
      setStatus(card, 'running');
      writeLine(card, `\n── ${time()} 开始运行 ──\n`, 'log-meta');
      writeLine(card, `$ ${evt.commandLine || ''}\n`, 'log-meta');
      writeLine(card, `  工作目录：${evt.cwd || '（未设置）'}\n\n`, 'log-meta');
      break;
    }
    case 'output': {
      writeLine(card, evt.text, evt.stream === 'stderr' ? 'log-err' : null);
      break;
    }
    case 'notice': {
      writeLine(card, `[提示] ${evt.text}\n`, 'log-warn');
      break;
    }
    case 'exit':
    case 'done': {
      finishCard(card, evt);
      break;
    }
    default:
      break;
  }
}

function finishCard(card, evt) {
  card.runId = null;
  const status = evt.status || 'failed';
  const duration = Number(evt.durationMs) || 0;

  setStatus(card, status);
  card.refs.runBtn.disabled = !card.tool.ready;
  card.refs.cancelBtn.disabled = true;

  const codeText = evt.exitCode == null ? '无退出码' : `退出码 ${evt.exitCode}`;
  const cls =
    status === 'success' ? 'log-ok' : status === 'failed' || status === 'error' ? 'log-err' : 'log-warn';
  writeLine(
    card,
    `── ${time()} 结束：${STATUS_TEXT[status] || status}（${codeText}），耗时 ${ctx.fmtTime(duration)} ──\n`,
    cls
  );
  if (evt.errorMessage) writeLine(card, `${evt.errorMessage}\n`, cls);

  card.refs.metrics.replaceChildren();
  const strong = document.createElement('b');
  strong.textContent = codeText;
  card.refs.metrics.append(strong, document.createTextNode(` · ${ctx.fmtTime(duration)}`));

  const lineCount = (evt.stdout || '').split('\n').length + (evt.stderr || '').split('\n').length;
  card.refs.logSize.textContent = `${lineCount} 行`;

  if (status === 'failed' || status === 'timeout') {
    ctx.toast(`「${card.tool.name}」${STATUS_TEXT[status]}：${evt.errorMessage || codeText}`, 'error', 5000);
  } else if (status === 'error') {
    ctx.toast(`「${card.tool.name}」执行异常：${evt.errorMessage || '未知错误'}`, 'error', 5000);
  }
}

/* ------------------------------------------------------------------ 渲染 */

function renderCards() {
  const tools = ctx.boot.tools || [];
  gridEl.replaceChildren();
  cards = new Map();

  for (const tool of tools) {
    const card = createCard(tool);
    cards.set(tool.id, card);
    gridEl.appendChild(card.node);
  }
  applyFilter();
}

function applyFilter() {
  const keyword = (toolbarInput?.value || '').trim().toLowerCase();
  let visible = 0;
  for (const card of cards.values()) {
    const tool = card.tool;
    const haystack = [tool.name, tool.description, tool.scriptPath, ...(tool.tags || [])]
      .join(' ')
      .toLowerCase();
    const match = !keyword || haystack.includes(keyword);
    card.node.hidden = !match;
    if (match) visible++;
  }
  const total = cards.size;
  countEl.textContent = keyword ? `匹配 ${visible} / ${total} 个工具` : `共 ${total} 个工具`;

  if (emptyEl) emptyEl.hidden = total > 0;
}

function clearAllLogs() {
  let cleared = 0;
  for (const card of cards.values()) {
    if (card.status !== 'running') {
      clearLog(card);
      cleared++;
    }
  }
  ctx.toast(cleared ? '已清空所有日志' : '没有可清空的日志', cleared ? 'success' : 'warn', 1800);
}

/* ------------------------------------------------------------ 脚本编辑器 */

function closeModal() {
  if (modalEl) {
    modalEl.remove();
    modalEl = null;
  }
}

function openEditor(toolId = null) {
  const { el } = ctx;
  const raw = toolId ? rawToolById(toolId) : null;
  const tool = toolId ? (ctx.boot.tools || []).find((t) => t.id === toolId) : null;
  const isEdit = !!toolId;

  const nameInput = el('input', {
    class: 'input',
    type: 'text',
    maxlength: '40',
    placeholder: '例如：森空岛 · 每日签到',
    value: (raw && raw.name) || '',
  });
  const descInput = el('input', {
    class: 'input',
    type: 'text',
    maxlength: '120',
    placeholder: '一句话说明这个脚本做什么',
    value: (raw && raw.description) || '',
  });
  const scriptInput = el('input', {
    class: 'input',
    type: 'text',
    placeholder: 'D:\\tools\\checkin.bat（建议填绝对路径）',
    value: (raw && raw.script) || (tool && tool.scriptPath) || '',
  });
  const cwdInput = el('input', {
    class: 'input',
    type: 'text',
    placeholder: '留空 = 脚本所在目录',
    value: (raw && raw.cwd) || '',
  });
  const timeoutInput = el('input', {
    class: 'input',
    type: 'number',
    min: '1',
    max: '86400',
    value: String((raw && raw.timeoutSeconds) || 300),
  });
  const argsInput = el('input', {
    class: 'input',
    type: 'text',
    placeholder: '用空格分隔，例如 --check --verbose',
    value: Array.isArray(raw && raw.args) ? raw.args.join(' ') : '',
  });
  const tagsInput = el('input', {
    class: 'input',
    type: 'text',
    placeholder: '用逗号分隔，例如 森空岛,签到',
    value: Array.isArray(raw && raw.tags) ? raw.tags.join(', ') : '',
  });
  const encodingSelect = el('select', { class: 'select' }, [
    el('option', { value: 'auto', text: '自动识别（推荐）' }),
    el('option', { value: 'utf-8', text: '强制 UTF-8' }),
    el('option', { value: 'gbk', text: '强制 GBK（老式脚本）' }),
  ]);
  encodingSelect.value = (raw && raw.encoding) || 'auto';

  const enabledInput = el('input', { type: 'checkbox' });
  enabledInput.checked = !(raw && raw.enabled === false);

  const browseScript = el('button', { class: 'btn', type: 'button', text: '浏览…' });
  browseScript.addEventListener('click', async () => {
    const res = await ctx.api.pickScript();
    if (res && res.ok) {
      scriptInput.value = res.path;
      if (!cwdInput.value) {
        const sep = res.path.includes('\\') ? '\\' : '/';
        cwdInput.value = res.path.slice(0, res.path.lastIndexOf(sep));
      }
    }
  });

  const browseCwd = el('button', { class: 'btn', type: 'button', text: '选择…' });
  browseCwd.addEventListener('click', async () => {
    const res = await ctx.api.pickDir();
    if (res && res.ok) cwdInput.value = res.path;
  });

  const saveBtn = el('button', { class: 'btn primary', type: 'button', text: isEdit ? '保存修改' : '添加工具' });
  const cancelBtn = el('button', { class: 'btn', type: 'button', text: '取消' });
  const deleteBtn = el('button', { class: 'btn danger', type: 'button', text: '删除此工具' });

  cancelBtn.addEventListener('click', closeModal);

  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const script = scriptInput.value.trim();
    if (!name) {
      ctx.toast('请填写工具名称', 'warn');
      nameInput.focus();
      return;
    }
    if (!script) {
      ctx.toast('请选择或填写 .bat 脚本路径', 'warn');
      scriptInput.focus();
      return;
    }
    if (!/\.(bat|cmd)$/i.test(script)) {
      ctx.toast('只支持 .bat / .cmd 脚本', 'warn');
      scriptInput.focus();
      return;
    }

    const args = argsInput.value.trim() ? argsInput.value.trim().split(/\s+/) : [];
    const tags = tagsInput.value.trim()
      ? tagsInput.value
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

    const entry = {
      ...(raw || {}),
      id: (raw && raw.id) || `tool-${Date.now().toString(36)}`,
      name,
      description: descInput.value.trim(),
      script,
      args,
      timeoutSeconds: Math.max(1, Math.min(86400, Number(timeoutInput.value) || 300)),
      tags,
      encoding: encodingSelect.value,
    };
    const cwd = cwdInput.value.trim();
    if (cwd) entry.cwd = cwd;
    else delete entry.cwd;
    if (enabledInput.checked) delete entry.enabled;
    else entry.enabled = false;

    const list = [...(ctx.boot.rawTools || [])];
    const index = list.findIndex((item) => item && item.id === entry.id);
    if (index === -1) list.push(entry);
    else list[index] = entry;

    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    const res = await ctx.api.saveTools(list);
    saveBtn.disabled = false;
    saveBtn.textContent = isEdit ? '保存修改' : '添加工具';
    if (!res || !res.ok) {
      ctx.toast(res?.error || '保存失败', 'error', 6000);
      return;
    }
    closeModal();
    // 主进程写完会广播 config-changed，外壳再回调 onConfigChanged 刷新卡片
    ctx.toast(res.message || '已保存', 'success', 3000);
  });

  deleteBtn.addEventListener('click', async () => {
    const confirm = await ctx.api.confirm({
      title: '删除工具',
      message: `确认从 tools.json 中删除「${nameInput.value.trim() || toolId}」吗？`,
      detail: '只会删掉这条配置，不会删除磁盘上的 .bat 文件。',
      confirmLabel: '删除',
      danger: true,
    });
    if (!confirm.ok) return;
    const list = (ctx.boot.rawTools || []).filter((item) => item && item.id !== toolId);
    const res = await ctx.api.saveTools(list);
    if (!res || !res.ok) {
      ctx.toast(res?.error || '删除失败', 'error');
      return;
    }
    closeModal();
    ctx.toast('已删除该工具', 'success');
  });

  const body = el('div', { class: 'modal-body' }, [
    el('div', { class: 'field' }, [el('label', { text: '名称' }), nameInput]),
    el('div', { class: 'field' }, [el('label', { text: '说明（可选）' }), descInput]),
    el('div', { class: 'field' }, [
      el('label', { text: '.bat / .cmd 脚本路径' }),
      el('div', { class: 'input-group' }, [scriptInput, browseScript]),
      el('span', { class: 'hint', text: '建议填绝对路径；相对路径会按「配置文件所在目录 → 程序目录」解析，支持 %USERPROFILE% 变量。' }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { text: '工作目录（可选）' }),
      el('div', { class: 'input-group' }, [cwdInput, browseCwd]),
      el('span', { class: 'hint', text: '留空则用脚本所在目录，保证脚本里的相对路径可用；路径含空格或中文都没问题。' }),
    ]),
    el('div', { class: 'form-row' }, [
      el('div', { class: 'field' }, [
        el('label', { text: '超时（秒）' }),
        timeoutInput,
      ]),
      el('div', { class: 'field' }, [el('label', { text: '输出编码' }), encodingSelect]),
    ]),
    el('div', { class: 'field' }, [
      el('label', { text: '参数（可选）' }),
      argsInput,
      el('span', { class: 'hint', text: '命令行参数用空格分隔；参数里不能含英文双引号。' }),
    ]),
    el('div', { class: 'field' }, [el('label', { text: '标签（可选）' }), tagsInput]),
    el('div', { class: 'field' }, [
      el('label', { class: 'switch' }, [enabledInput, el('span', { text: '在面板上显示这个工具' })]),
    ]),
    el('div', { class: 'notice' }, [
      el('span', { text: '保存后会写回 tools.json（原文件备份为 tools.json.bak），并立即刷新面板，无需重启。' }),
    ]),
  ]);

  const foot = el('div', { class: 'modal-foot' }, [
    isEdit ? deleteBtn : null,
    el('span', { class: 'spacer' }),
    cancelBtn,
    saveBtn,
  ]);

  const modal = el('div', { class: 'modal' }, [
    el('div', { class: 'modal-head' }, [
      el('h2', { text: isEdit ? '编辑脚本工具' : '新增脚本工具' }),
      el('p', { text: isEdit ? `id：${toolId}` : '保存后会自动生成唯一 id' }),
    ]),
    body,
    foot,
  ]);

  modalEl = el('div', { class: 'modal-mask' }, [modal]);
  modalEl.addEventListener('mousedown', (e) => {
    if (e.target === modalEl) closeModal();
  });
  document.body.appendChild(modalEl);
  setTimeout(() => nameInput.focus(), 30);
}

/* ------------------------------------------------------------------ 头部 */

function emptyCard() {
  const { el } = ctx;
  const addBtn = el('button', { class: 'btn primary', type: 'button', text: '新增脚本工具' });
  addBtn.addEventListener('click', () => openEditor(null));
  return el('div', { class: 'card' }, [
    el('h2', { text: '还没有配置任何脚本工具' }),
    el('p', {
      class: 'muted',
      text: '可以直接在界面上新增，也可以编辑配置文件 config/tools.json，每条长这样：',
    }),
    el('pre', {
      class: 'mono',
      text: `{
  "id": "my-tool",
  "name": "我的脚本",
  "description": "这个脚本做什么",
  "script": "E:\\\\path\\\\to\\\\your.bat",
  "cwd": "E:\\\\path\\\\to",
  "timeoutSeconds": 300,
  "args": [],
  "tags": ["示例"]
}`,
    }),
    el('div', { class: 'empty-actions' }, [addBtn]),
  ]);
}

function updateHeader() {
  const total = (ctx.boot.tools || []).length;
  ctx.setHeader({
    title: '脚本工具',
    description:
      total > 0
        ? `共 ${total} 个脚本工具 · 点击「运行」立即执行，执行过程与结果实时显示`
        : '暂无工具，点「新增脚本」或在 config/tools.json 里添加',
    actions: [
      { label: '新增脚本', variant: 'primary', onClick: () => openEditor(null) },
      { label: '清空所有日志', onClick: clearAllLogs },
    ],
  });
}

/* ------------------------------------------------------------- 模块生命周期 */

export default {
  async mount(root, moduleCtx) {
    ctx = moduleCtx;
    unsubscribe?.();
    if (ticker) clearInterval(ticker);

    const { el } = ctx;
    root.replaceChildren();

    const searchInput = el('input', {
      type: 'search',
      placeholder: '搜索工具名称、说明或脚本路径…',
      'aria-label': '搜索工具',
    });
    toolbarInput = searchInput;
    searchInput.addEventListener('input', applyFilter);

    const searchIcon = document.createElement('span');
    searchIcon.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="width:14px;height:14px;display:block"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

    const searchBox = el('div', { class: 'search-box' }, [searchIcon, searchInput]);
    countEl = el('span', { class: 'tool-count', text: '' });
    emptyEl = emptyCard();
    gridEl = el('div', { class: 'tool-grid' });

    root.append(el('div', { class: 'tool-toolbar' }, [searchBox, countEl]), emptyEl, gridEl);

    renderCards();
    updateHeader();
    unsubscribe = ctx.api.onRunEvent(handleRunEvent);

    ticker = setInterval(() => {
      for (const card of cards.values()) {
        if (card.status !== 'running' || !card.startedAt) continue;
        card.refs.metrics.textContent = `已运行 ${ctx.fmtTime(Date.now() - card.startedAt)}`;
      }
    }, 500);
  },

  async unmount() {
    unsubscribe?.();
    unsubscribe = null;
    if (ticker) clearInterval(ticker);
    ticker = null;
    cards = new Map();
    closeModal();
  },

  updateHeader,

  /** 配置热更新：尽量原地刷新，保留正在运行任务的日志 */
  async onConfigChanged(moduleCtx, boot) {
    ctx = moduleCtx;
    const incoming = boot.tools || [];

    for (const [id, card] of [...cards]) {
      if (!incoming.some((t) => t.id === id)) {
        card.node.remove();
        cards.delete(id);
      }
    }
    for (const tool of incoming) {
      const existing = cards.get(tool.id);
      if (existing) {
        applyToolState(existing, tool);
      } else {
        const card = createCard(tool);
        cards.set(tool.id, card);
        gridEl.appendChild(card.node);
      }
    }
    applyFilter();
    updateHeader();
  },

  clearAllLogs,
};
