'use strict';

/**
 * config-store.js — 配置发现 / 读取 / 校验 / 回写
 *
 * 不依赖 electron，方便单测。职责：
 *  1. 在若干候选目录里找到「用户可编辑」的配置目录；
 *  2. 读取 tools.json（按钮 → 脚本 映射）与 modules.json（模块开关 / 排序）；
 *  3. 把一切问题收敛成 warnings / problems，绝不因为一处配置写错就让程序起不来；
 *  4. 支持界面上增删改工具后回写 tools.json（写前自动备份）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { prepareTool } = require('./runner');

const TOOLS_FILE = 'tools.json';
const MODULES_FILE = 'modules.json';

/** 读取并解析 JSON，失败时抛出带中文说明的错误 */
function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`无法读取 ${path.basename(filePath)}：${err.code || err.message}`);
  }
  // 去掉可能存在的 BOM
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path.basename(filePath)} 不是合法 JSON：${err.message}`);
  }
}

/** 确保目录存在（用于首次运行把内置配置复制到用户目录） */
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** 把内置默认配置复制到可写目录（已存在的文件不覆盖） */
function seedConfigDir(sourceDir, targetDir) {
  const copied = [];
  if (!sourceDir || !fs.existsSync(sourceDir)) return copied;
  if (!ensureDir(targetDir)) return copied;
  for (const name of fs.readdirSync(sourceDir)) {
    const src = path.join(sourceDir, name);
    const dest = path.join(targetDir, name);
    try {
      if (!fs.statSync(src).isFile()) continue;
      if (fs.existsSync(dest)) continue;
      fs.copyFileSync(src, dest);
      copied.push(name);
    } catch {
      /* 单个文件失败不影响整体 */
    }
  }
  return copied;
}

/** 归一化 tools.json：既接受 { "tools": [...] }，也接受裸数组 */
function normalizeToolsPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.tools)) return payload.tools;
  if (payload && Array.isArray(payload.items)) return payload.items;
  return null;
}

/**
 * 加载并校验整套配置。
 * @param {string} configDir 配置目录
 * @param {object} [options]
 * @param {string[]} [options.fallbackRoots] 相对路径的兜底基准目录（程序目录 / 资源目录）
 * @returns {{ok:boolean, dir:string, tools:object[], rawTools:object[], modules:object, warnings:string[], exists:boolean}}
 */
function loadConfig(configDir, options = {}) {
  const fallbackRoots = Array.isArray(options.fallbackRoots) ? options.fallbackRoots : [];
  const warnings = [];
  const result = {
    ok: true,
    dir: configDir,
    exists: fs.existsSync(configDir),
    tools: [],
    rawTools: [],
    modules: {},
    warnings,
    toolsModifiedAt: null,
    modulesModifiedAt: null,
  };

  if (!result.exists) {
    warnings.push(`配置目录不存在：${configDir}（将使用空工具列表）`);
    result.ok = false;
    return result;
  }

  // ---------------- tools.json
  const toolsPath = path.join(configDir, TOOLS_FILE);
  if (!fs.existsSync(toolsPath)) {
    warnings.push(`缺少 ${TOOLS_FILE}，工具面板将为空。请参考 README 创建该文件。`);
  } else {
    try {
      result.toolsModifiedAt = fs.statSync(toolsPath).mtimeMs;
      const payload = readJsonFile(toolsPath);
      const list = normalizeToolsPayload(payload);
      if (!list) {
        warnings.push(`${TOOLS_FILE} 结构不正确，应为 {"tools": [...]} 或 [ ... ]。`);
      } else {
        const seen = new Set();
        list.forEach((rawTool, index) => {
          if (!rawTool || typeof rawTool !== 'object') {
            warnings.push(`第 ${index + 1} 条工具配置不是对象，已忽略。`);
            return;
          }
          // 保留原始条目（含 enabled:false 的），供界面编辑时回写
          result.rawTools.push(rawTool);
          // 显式禁用：直接跳过，不做校验也不产生告警
          if (rawTool.enabled === false) return;

          const prepared = prepareTool(rawTool, configDir, fallbackRoots);
          const tool = prepared.tool || {
            id: `invalid-${index}`,
            name: `第 ${index + 1} 条配置`,
            description: '',
            scriptPath: '',
            cwd: '',
            args: [],
            timeoutMs: 0,
            tags: [],
            enabled: true,
          };
          if (!prepared.ok) {
            prepared.problems.forEach((p) => warnings.push(`[${tool.name}] ${p}`));
          }
          if (tool.id) {
            if (seen.has(tool.id)) {
              warnings.push(`[${tool.name}] id "${tool.id}" 重复，已忽略后一条。`);
              return;
            }
            seen.add(tool.id);
          }
          result.tools.push({
            ...tool,
            ready: prepared.ok,
            problems: prepared.problems,
          });
        });
      }
    } catch (err) {
      warnings.push(err.message);
      result.ok = false;
    }
  }

  // ---------------- modules.json（可选）
  const modulesPath = path.join(configDir, MODULES_FILE);
  if (fs.existsSync(modulesPath)) {
    try {
      result.modulesModifiedAt = fs.statSync(modulesPath).mtimeMs;
      const payload = readJsonFile(modulesPath);
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        result.modules = payload;
      } else {
        warnings.push(`${MODULES_FILE} 应为 JSON 对象，当前内容已被忽略。`);
      }
    } catch (err) {
      warnings.push(err.message);
    }
  }

  return result;
}

/**
 * 把界面编辑后的工具数组写回 tools.json。
 * 保留文件里原有的 $schema / _note / version 等字段，只替换 tools。
 * 写之前备份一份 tools.json.bak，写失败时原文件不受影响（先写临时文件再 rename）。
 *
 * @returns {{ok:boolean, backup?:string, error?:string, count?:number}}
 */
function saveTools(configDir, tools) {
  if (!Array.isArray(tools)) return { ok: false, error: 'tools 必须是数组' };
  const toolsPath = path.join(configDir, TOOLS_FILE);

  // 逐条做最少校验，避免把明显错误的数据写进去
  for (let i = 0; i < tools.length; i++) {
    const item = tools[i];
    if (!item || typeof item !== 'object') {
      return { ok: false, error: `第 ${i + 1} 条不是合法的工具对象` };
    }
    const id = String(item.id || '').trim();
    if (!id) return { ok: false, error: `第 ${i + 1} 条缺少 id` };
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
      return { ok: false, error: `id "${id}" 只能用字母、数字、下划线、点和短横线` };
    }
    if (!String(item.script || '').trim()) {
      return { ok: false, error: `「${item.name || id}」缺少 .bat 路径` };
    }
  }
  const ids = tools.map((t) => String(t.id).trim());
  const dup = ids.find((id, index) => ids.indexOf(id) !== index);
  if (dup) return { ok: false, error: `id "${dup}" 重复了，请改成唯一值` };

  let payload = { $schema: './tools.schema.json', version: 1, tools: [] };
  if (fs.existsSync(toolsPath)) {
    try {
      const existing = readJsonFile(toolsPath);
      if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        payload = { ...existing, tools: [] };
      }
    } catch {
      /* 原文件坏了也允许覆盖保存（下面会先备份） */
    }
  }

  let backup = null;
  try {
    if (!ensureDir(configDir)) throw new Error('配置目录不可写');
    if (fs.existsSync(toolsPath)) {
      backup = `${toolsPath}.bak`;
      fs.copyFileSync(toolsPath, backup);
    }
    payload.tools = tools;
    const tmp = `${toolsPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, toolsPath);
    return { ok: true, backup, count: tools.length };
  } catch (err) {
    return { ok: false, error: `写入 ${TOOLS_FILE} 失败：${err.code || err.message}` };
  }
}

/**
 * 扫描前端模块目录，读取每个模块的 module.json。
 * 新增一个模块 = 新建目录 + module.json + 入口 js，无需改任何主流程代码。
 */
function scanModules(modulesRoot) {
  const manifests = [];
  const warnings = [];
  if (!fs.existsSync(modulesRoot)) {
    warnings.push(`模块目录不存在：${modulesRoot}`);
    return { manifests, warnings };
  }

  for (const dirent of fs.readdirSync(modulesRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const dir = path.join(modulesRoot, dirent.name);
    const manifestPath = path.join(dir, 'module.json');
    if (!fs.existsSync(manifestPath)) {
      warnings.push(`模块目录 ${dirent.name} 缺少 module.json，已跳过。`);
      continue;
    }
    try {
      const manifest = readJsonFile(manifestPath);
      const entry = manifest.entry || 'module.js';
      if (!fs.existsSync(path.join(dir, entry))) {
        warnings.push(`模块 ${dirent.name} 的入口文件 ${entry} 不存在，已跳过。`);
        continue;
      }
      manifests.push({
        id: manifest.id || dirent.name,
        dir: dirent.name,
        entry,
        title: manifest.title || manifest.name || dirent.name,
        icon: manifest.icon || 'square',
        description: manifest.description || '',
        styles: Array.isArray(manifest.styles) ? manifest.styles.map(String) : [],
        order: Number.isFinite(Number(manifest.order)) ? Number(manifest.order) : 100,
        defaultEnabled: manifest.defaultEnabled !== false,
        settings: manifest.settings || {},
      });
    } catch (err) {
      warnings.push(`模块 ${dirent.name} 的 module.json 解析失败：${err.message}`);
    }
  }
  return { manifests, warnings };
}

/**
 * 合并模块清单与 modules.json 的开关/排序/标题覆盖。
 * @returns {{modules: object[], warnings: string[]}}
 */
function resolveModules(manifests, modulesConfig) {
  const cfg = modulesConfig && typeof modulesConfig === 'object' ? modulesConfig : {};
  const overrides =
    cfg.modules && typeof cfg.modules === 'object' && !Array.isArray(cfg.modules)
      ? cfg.modules
      : {};
  const orderList = Array.isArray(cfg.order) ? cfg.order : [];
  const warnings = [];

  const resolved = manifests.map((manifest) => {
    const override = overrides[manifest.id] || {};
    const enabled =
      typeof override.enabled === 'boolean' ? override.enabled : manifest.defaultEnabled;
    return {
      ...manifest,
      title: typeof override.title === 'string' && override.title ? override.title : manifest.title,
      enabled,
      settings: { ...manifest.settings, ...(override.settings || {}) },
    };
  });

  // 未在 modules.json 中声明的模块 id 提示一下（多半是拼写错误）
  for (const id of Object.keys(overrides)) {
    if (!manifests.some((m) => m.id === id)) {
      warnings.push(`${MODULES_FILE} 里的模块 "${id}" 不存在，已忽略。`);
    }
  }

  resolved.sort((a, b) => {
    const ai = orderList.indexOf(a.id);
    const bi = orderList.indexOf(b.id);
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    return a.order - b.order || a.id.localeCompare(b.id);
  });

  return { modules: resolved.filter((m) => m.enabled), warnings };
}

module.exports = {
  TOOLS_FILE,
  MODULES_FILE,
  readJsonFile,
  ensureDir,
  seedConfigDir,
  loadConfig,
  saveTools,
  scanModules,
  resolveModules,
};
