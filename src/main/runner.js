'use strict';

/**
 * runner.js — .bat / .cmd 脚本执行引擎
 *
 * 设计原则：
 *  1. 纯 Node 模块，不依赖 electron，可用 `node tools/test-core.js` 直接单测。
 *  2. 所有失败路径都转成结构化结果（status / errorMessage），绝不抛到主进程顶层。
 *  3. 输出流式回传，按块批量发送，避免大数据量把 IPC 冲爆。
 *  4. 编码自适应：优先 UTF-8，遇到非法 UTF-8 字节序列自动降级 GBK（中文 Windows 常见）。
 *  5. 进程以隐藏窗口启动，标准输入接空设备（脚本里的 pause 会立即返回，不会挂起界面）。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 单路输出最多保留 2MB
const FLUSH_INTERVAL_MS = 40; // 输出合并推送间隔
const KILL_GRACE_MS = 5000; // 强杀后等待 close 的兜底时间
const SUPPORTED_EXT = ['.bat', '.cmd'];

/** 正在运行的进程记录：runId -> ctx */
const activeRuns = new Map();
/** 同一工具同时只允许一个实例：toolId -> runId */
const activeByTool = new Map();

// ---------------------------------------------------------------- 工具函数

/** 展开 %USERPROFILE% 这类环境变量（配置里写绝对路径时不写死用户名很有用） */
function expandEnv(input) {
  if (typeof input !== 'string' || !input.includes('%')) return input;
  return input.replace(/%([^%]+)%/g, (whole, name) => {
    const key = Object.keys(process.env).find(
      (k) => k.toUpperCase() === String(name).toUpperCase()
    );
    return key ? process.env[key] : whole;
  });
}

/** 判断 buffer 是否是「合法 UTF-8」（允许结尾有被截断的多字节字符） */
function isProbablyUtf8(buf) {
  for (let trim = 0; trim <= 3 && trim < buf.length; trim++) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, buf.length - trim));
      return true;
    } catch {
      /* 继续尝试剪掉结尾残字节 */
    }
  }
  return false;
}

/**
 * 流式解码器：先缓冲一小段样本判断编码，之后按判定结果流式解码。
 * encoding 可取 'auto' | 'utf-8' | 'gbk'（由配置 tools.json 的 encoding 字段指定）。
 */
class StreamDecoder {
  constructor(encoding = 'auto') {
    this.mode = encoding === 'auto' ? 'auto' : encoding;
    this.encoding = this.mode === 'auto' ? 'utf-8' : this.mode;
    this.decided = this.mode !== 'auto';
    this.decoder = this.decided ? StreamDecoder.createDecoder(this.encoding) : null;
    this.pending = [];
    this.pendingBytes = 0;
    this.startedAt = 0;
  }

  static createDecoder(enc) {
    try {
      return new TextDecoder(enc);
    } catch {
      return new TextDecoder('utf-8');
    }
  }

  /** 喂入原始字节，返回可以立刻展示的文本（可能为空字符串） */
  push(buf) {
    if (this.decided) return this.decoder.decode(buf, { stream: true });
    if (!this.startedAt) this.startedAt = Date.now();
    // 纯 ASCII 在 UTF-8 / GBK 下结果完全一致，直接输出，避免首字节被缓冲
    if (this.pending.length === 0 && !/[\x80-\xff]/.test(buf.toString('latin1'))) {
      return buf.toString('latin1');
    }
    this.pending.push(buf);
    this.pendingBytes += buf.length;
    if (this.pendingBytes >= 8192) return this.decide();
    return '';
  }

  /** 首块输出迟迟不到 8KB 时，由定时器调用，避免界面看起来「卡住」 */
  flushByTime(now = Date.now()) {
    if (this.decided || this.pendingBytes === 0) return '';
    if (now - this.startedAt < 150) return '';
    return this.decide();
  }

  decide() {
    const head = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    this.encoding = isProbablyUtf8(head) ? 'utf-8' : 'gbk';
    this.decoder = StreamDecoder.createDecoder(this.encoding);
    this.decided = true;
    return this.decoder.decode(head, { stream: true });
  }

  end() {
    let text = '';
    if (!this.decided && this.pendingBytes > 0) text += this.decide();
    try {
      text += this.decoder.decode();
    } catch {
      /* 忽略尾部残字节 */
    }
    return text;
  }
}

/** 以 cmd 语义给单个参数加引号（不支持内嵌双引号，已在预检阶段拦截） */
function quoteCmdArg(value) {
  const str = String(value);
  return /[\s&|<>^()"']/.test(str) ? `"${str}"` : str;
}

/** 工作目录不存在时向上回溯，找到第一个存在的父目录，用于提示 */
function nearestExistingDir(dir) {
  let cur = dir;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/**
 * 把相对路径解析成绝对路径：先按配置目录，再按若干兜底根目录（程序目录 / 资源目录）找。
 * 这样默认配置里写 `scripts\\demo-hello.bat` 在开发态与打包后都能找到。
 */
function resolveConfigPath(rawPath, bases) {
  const candidates = [];
  for (const base of [].concat(bases || []).filter(Boolean)) {
    const abs = path.normalize(path.resolve(base, rawPath));
    candidates.push(abs);
    if (fs.existsSync(abs)) return abs;
  }
  return candidates[0] || path.normalize(rawPath);
}

// ---------------------------------------------------------------- 配置预检

/**
 * 把一条 tools.json 里的工具配置解析成可执行描述，并做完整校验。
 * 返回 { ok, tool, problems[] }，problems 是中文可读提示，直接展示给用户。
 *
 * @param {object} tool  原始配置对象
 * @param {string} configDir 配置文件所在目录（相对路径的第一基准）
 * @param {string[]} [fallbackRoots] 相对路径的兜底基准目录
 */
function prepareTool(tool, configDir, fallbackRoots = []) {
  const problems = [];
  const id = tool && (tool.id || tool.toolId);
  const name = (tool && (tool.name || tool.title)) || id || '未命名工具';
  const bases = [configDir, ...fallbackRoots].filter(Boolean);

  if (!tool || typeof tool !== 'object') {
    return { ok: false, tool: null, problems: ['工具配置不是合法的 JSON 对象'] };
  }
  if (!id || typeof id !== 'string') {
    problems.push('缺少 id 字段（每个工具必须有唯一 id）');
  }

  const rawScript = tool.script ?? tool.bat ?? tool.path;
  if (!rawScript || typeof rawScript !== 'string') {
    problems.push('缺少 script 字段（.bat 文件路径）');
  }

  let scriptPath = rawScript ? expandEnv(rawScript.trim()) : '';
  if (scriptPath && !path.isAbsolute(scriptPath)) {
    scriptPath = resolveConfigPath(scriptPath, bases);
  }
  if (scriptPath) scriptPath = path.normalize(scriptPath);

  if (scriptPath) {
    const ext = path.extname(scriptPath).toLowerCase();
    if (!SUPPORTED_EXT.includes(ext)) {
      problems.push(`只支持 .bat / .cmd 脚本，当前是 "${ext || '(无扩展名)'}"：${scriptPath}`);
    } else if (!fs.existsSync(scriptPath)) {
      const hint = nearestExistingDir(path.dirname(scriptPath));
      problems.push(
        `脚本文件不存在：${scriptPath}` +
          (hint && hint !== path.dirname(scriptPath) ? `（最接近存在的目录是 ${hint}）` : '')
      );
    } else {
      try {
        const stat = fs.statSync(scriptPath);
        if (!stat.isFile()) problems.push(`脚本路径不是文件：${scriptPath}`);
      } catch (err) {
        problems.push(`读取脚本信息失败：${path.basename(scriptPath)}（${err.code || err.message}）`);
      }
    }
  }

  // 工作目录：未配置时默认用脚本所在目录（.bat 里的相对路径才有意义）
  const rawCwd = tool.cwd ?? tool.workdir ?? tool.workingDirectory;
  let cwd = '';
  if (rawCwd && typeof rawCwd === 'string' && rawCwd.trim()) {
    cwd = expandEnv(rawCwd.trim());
    if (!path.isAbsolute(cwd)) cwd = resolveConfigPath(cwd, bases);
    cwd = path.normalize(cwd);
    if (!fs.existsSync(cwd)) {
      problems.push(`工作目录不存在：${cwd}`);
    } else {
      try {
        if (!fs.statSync(cwd).isDirectory()) problems.push(`工作目录不是文件夹：${cwd}`);
      } catch (err) {
        problems.push(`读取工作目录失败：${cwd}（${err.code || err.message}）`);
      }
    }
  } else if (scriptPath) {
    cwd = path.dirname(scriptPath);
  }

  // 参数
  const rawArgs = tool.args ?? tool.arguments ?? [];
  let args = [];
  if (typeof rawArgs === 'string') {
    args = rawArgs.trim() ? [rawArgs.trim()] : [];
  } else if (Array.isArray(rawArgs)) {
    args = rawArgs.map((a) => String(a));
  } else if (rawArgs != null) {
    problems.push('args 字段必须是字符串数组，例如 ["--check"]');
  }
  if (args.some((a) => /["\r\n]/.test(a))) {
    problems.push('args 中的参数不能包含英文双引号或换行符');
  }

  // 超时（允许 timeoutSeconds 或 timeoutMs）
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (Number.isFinite(Number(tool.timeoutSeconds)) && Number(tool.timeoutSeconds) > 0) {
    timeoutMs = Math.min(Number(tool.timeoutSeconds), 24 * 3600) * 1000;
  } else if (Number.isFinite(Number(tool.timeoutMs)) && Number(tool.timeoutMs) > 0) {
    timeoutMs = Math.min(Number(tool.timeoutMs), 24 * 3600 * 1000);
  }

  const encoding = ['auto', 'utf-8', 'gbk'].includes(tool.encoding) ? tool.encoding : 'auto';

  const normalized = {
    id: String(id || ''),
    name: String(name),
    description: tool.description || tool.desc || '',
    scriptPath,
    cwd,
    args,
    timeoutMs,
    encoding,
    env: tool.env && typeof tool.env === 'object' ? tool.env : null,
    tags: Array.isArray(tool.tags) ? tool.tags.map(String) : [],
    enabled: tool.enabled !== false,
    configIssue: problems[0] || null,
  };

  return { ok: problems.length === 0, tool: normalized, problems };
}

/** 执行前展示给用户的命令行预览（不真正执行） */
function buildCommandPreview(tool) {
  const argsPart = tool.args.length ? ' ' + tool.args.map(quoteCmdArg).join(' ') : '';
  return `call ${quoteCmdArg(tool.scriptPath)}${argsPart}`;
}

// ---------------------------------------------------------------- 进程控制

/** 强杀整个进程树（cmd → python 等子进程），失败则退回普通 kill */
function killTree(child) {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode !== null) return resolve();
    const pid = child.pid;
    if (!pid) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      return resolve();
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('close', done);
      killer.on('error', () => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        done();
      });
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      done();
    }
    setTimeout(done, 4000);
  });
}

// ---------------------------------------------------------------- 主入口

/**
 * 执行一个已由 prepareTool 归一化的工具。
 * @param {object} tool      prepareTool().tool
 * @param {object} options
 * @param {(event:object)=>void} options.onEvent  运行事件回调
 * @returns {Promise<object>} 运行结果摘要
 */
function runTool(tool, options = {}) {
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const runId = options.runId || crypto.randomUUID();
  const startedAt = Date.now();

  const summary = {
    runId,
    toolId: tool.id,
    name: tool.name,
    status: 'running',
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelled: false,
    errorMessage: null,
    encoding: tool.encoding,
    scriptPath: tool.scriptPath,
    cwd: tool.cwd,
    commandLine: buildCommandPreview(tool),
    startedAt,
    endedAt: null,
    durationMs: 0,
    stdout: '',
    stderr: '',
    truncated: false,
  };

  const emit = (type, payload = {}) => {
    try {
      onEvent({ runId, toolId: tool.id, type, ...payload });
    } catch {
      /* 回调异常不能影响执行 */
    }
  };

  // 运行前校验（脚本丢失 / 目录无效在这里就返回中文提示，不启动进程）
  if (!tool.scriptPath || !fs.existsSync(tool.scriptPath)) {
    summary.status = 'error';
    summary.errorMessage = `脚本文件不存在：${tool.scriptPath || '(未配置)'}`;
    summary.endedAt = Date.now();
    emit('start', summary);
    emit('exit', summary);
    return Promise.resolve(summary);
  }
  if (tool.cwd && !fs.existsSync(tool.cwd)) {
    summary.status = 'error';
    summary.errorMessage = `工作目录不存在：${tool.cwd}`;
    summary.endedAt = Date.now();
    emit('start', summary);
    emit('exit', summary);
    return Promise.resolve(summary);
  }

  const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  // 不注入 chcp：批处理自己怎么写代码页就怎么跑，行为与双击一致。
  // （强制 chcp 65001 会让 GBK 老脚本的中文变乱码，也会触发 cmd 解析 UTF-8 批处理的吃字 bug。）
  const innerCommand =
    `call ${quoteCmdArg(tool.scriptPath)}` +
    (tool.args.length ? ' ' + tool.args.map(quoteCmdArg).join(' ') : '');

  let child;
  try {
    child = spawn(comspec, ['/d', '/s', '/c', `"${innerCommand}"`], {
      cwd: tool.cwd || undefined,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(tool.env || {}),
        TOOLBOX_TOOL_ID: tool.id,
      },
    });
  } catch (err) {
    summary.status = 'error';
    summary.errorMessage = `无法启动脚本进程：${err.message}`;
    summary.endedAt = Date.now();
    emit('start', summary);
    emit('exit', summary);
    return Promise.resolve(summary);
  }

  const ctx = {
    child,
    summary,
    emit,
    killRequested: false,
    killReason: null,
    finished: false,
    timer: null,
    flushTimer: null,
    decoders: {},
    buffers: { stdout: [], stderr: [] },
    emittedBytes: { stdout: 0, stderr: 0 },
  };
  activeRuns.set(runId, ctx);
  activeByTool.set(tool.id, runId);

  emit('start', summary);

  // ---- 输出收集
  for (const streamName of ['stdout', 'stderr']) {
    ctx.decoders[streamName] = new StreamDecoder(tool.encoding);
    const pipe = child[streamName];
    if (!pipe) continue;
    pipe.on('data', (chunk) => {
      if (ctx.finished) return;
      const text = ctx.decoders[streamName].push(chunk);
      if (text) pushOutput(ctx, streamName, text);
    });
    pipe.on('error', () => {
      /* 管道错误忽略，进程 close 事件会给出最终结果 */
    });
  }

  function pushOutput(ctx, streamName, text) {
    if (ctx.summary.truncated) return; // 已截断：继续读但丢弃，防止子进程被管道写满卡死
    ctx.buffers[streamName].push(text);
    ctx.summary[streamName] += text;
    ctx.emittedBytes[streamName] += Buffer.byteLength(text);
    if (ctx.emittedBytes[streamName] > MAX_OUTPUT_BYTES) {
      ctx.summary.truncated = true;
      const notice = `\n[输出超过 ${Math.round(MAX_OUTPUT_BYTES / 1024 / 1024)}MB，后续内容已省略]\n`;
      ctx.summary[streamName] += notice;
      flushOutput(ctx, streamName, notice);
    }
  }

  function flushOutput(ctx, streamName, extra) {
    let text = ctx.buffers[streamName].join('');
    ctx.buffers[streamName] = [];
    if (extra) text += extra;
    if (!text) return;
    ctx.emit('output', { stream: streamName, text });
  }

  function flushAll(ctx) {
    const now = Date.now();
    for (const streamName of ['stdout', 'stderr']) {
      const decoder = ctx.decoders[streamName];
      if (decoder) {
        const late = decoder.flushByTime(now);
        if (late) ctx.buffers[streamName].push(late);
      }
      if (ctx.buffers[streamName].length) flushOutput(ctx, streamName);
    }
  }

  ctx.flushTimer = setInterval(() => flushAll(ctx), FLUSH_INTERVAL_MS);

  // ---- 超时看门狗
  if (tool.timeoutMs > 0) {
    ctx.timer = setTimeout(() => {
      if (ctx.finished) return;
      ctx.killRequested = true;
      ctx.killReason = 'timeout';
      ctx.summary.timedOut = true;
      ctx.emit('notice', {
        level: 'warn',
        text: `执行超过 ${Math.round(tool.timeoutMs / 1000)} 秒，已强制结束进程。`,
      });
      killTree(child);
    }, tool.timeoutMs);
  }

  const finish = (exitCode, signal, spawnError) => {
    if (ctx.finished) return;
    ctx.finished = true;
    clearInterval(ctx.flushTimer);
    if (ctx.timer) clearTimeout(ctx.timer);
    activeRuns.delete(runId);
    if (activeByTool.get(tool.id) === runId) activeByTool.delete(tool.id);

    // 收尾：把解码器里最后一点内容冲出来
    for (const streamName of ['stdout', 'stderr']) {
      const decoder = ctx.decoders[streamName];
      if (!decoder) continue;
      const tail = decoder.end();
      if (tail && !ctx.summary.truncated) {
        ctx.buffers[streamName].push(tail);
        ctx.summary[streamName] += tail;
      }
      if (ctx.buffers[streamName].length) flushOutput(ctx, streamName);
    }

    summary.exitCode = typeof exitCode === 'number' ? exitCode : null;
    summary.signal = signal || null;
    summary.endedAt = Date.now();
    summary.durationMs = summary.endedAt - summary.startedAt;
    // 把实际判定出的编码回报给界面，方便排查乱码
    const stdoutDecoder = ctx.decoders.stdout;
    if (stdoutDecoder && stdoutDecoder.encoding) summary.encoding = stdoutDecoder.encoding;

    if (summary.cancelled) {
      summary.status = 'cancelled';
      summary.errorMessage = '已被用户中止';
    } else if (summary.timedOut) {
      summary.status = 'timeout';
      summary.errorMessage = `执行超时（超过 ${Math.round(tool.timeoutMs / 1000)} 秒），进程已被强制结束`;
    } else if (spawnError) {
      summary.status = 'error';
      summary.errorMessage = `无法执行脚本：${spawnError.message}`;
    } else if (summary.exitCode === 0) {
      summary.status = 'success';
    } else if (summary.exitCode === null) {
      summary.status = 'failed';
      summary.errorMessage = `进程被信号 ${summary.signal || '未知'} 终止`;
    } else {
      summary.status = 'failed';
      summary.errorMessage = `脚本返回非零退出码：${summary.exitCode}`;
    }

    ctx.emit('exit', summary);
  };

  child.on('error', (err) => {
    // ENOENT / EACCES 等：进程根本没起来
    finish(null, null, err);
  });

  child.on('close', (code, signal) => {
    finish(code, signal, null);
  });

  // 兜底：极端情况下 close 迟迟不来（例如强杀后句柄未释放）
  const hardStop = setTimeout(
    () => {
      if (!ctx.finished) {
        killTree(child).then(() => {
          setTimeout(() => finish(null, 'SIGKILL', null), 800);
        });
      }
    },
    (tool.timeoutMs > 0 ? tool.timeoutMs : DEFAULT_TIMEOUT_MS) + KILL_GRACE_MS + 60000
  );
  hardStop.unref?.();

  return new Promise((resolve) => {
    const originalEmit = ctx.emit;
    ctx.emit = (type, payload) => {
      originalEmit(type, payload);
      if (type === 'exit') resolve(payload);
    };
  });
}

/** 用户点「中止」 */
function cancelRun(runId) {
  const ctx = activeRuns.get(runId);
  if (!ctx) return false;
  ctx.summary.cancelled = true;
  ctx.killRequested = true;
  ctx.killReason = 'cancel';
  ctx.emit('notice', { level: 'warn', text: '正在中止脚本…' });
  killTree(ctx.child);
  return true;
}

/** 退出应用前清理所有子进程 */
async function cancelAll() {
  const ctxs = [...activeRuns.values()];
  await Promise.all(ctxs.map((ctx) => killTree(ctx.child)));
  return ctxs.length;
}

function isToolRunning(toolId) {
  return activeByTool.has(toolId);
}

function listActiveRuns() {
  return [...activeRuns.values()].map((ctx) => ({
    runId: ctx.summary.runId,
    toolId: ctx.summary.toolId,
    startedAt: ctx.summary.startedAt,
  }));
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  SUPPORTED_EXT,
  StreamDecoder,
  isProbablyUtf8,
  expandEnv,
  resolveConfigPath,
  prepareTool,
  buildCommandPreview,
  runTool,
  cancelRun,
  cancelAll,
  isToolRunning,
  listActiveRuns,
};
