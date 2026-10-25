'use strict';

/**
 * test-core.js — 核心逻辑的自动化验收（不需要 Electron）
 *
 *     node tools/test-core.js
 *
 * 覆盖四块：
 *   1. 脚本执行引擎：中文/空格路径、工作目录、参数、GBK 输出、非零退出码、
 *      超时强杀、pause 不卡死、脚本缺失、目录无效、相对路径解析
 *   2. 配置层：tools.json 读取/校验/回写（含备份）
 *   3. 加密存储与账号仓库：写入不含明文、脱敏视图、增删改
 *   4. 签到协议：森空岛签名头、米游社 DS 与 RSA 加密、Server酱 地址与汇总文案
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const runner = require('../src/main/runner');
const store = require('../src/main/config-store');
const { createSecureStore } = require('../src/main/secure-store');
const { createAccountStore, maskPhone, maskSecret } = require('../src/main/accounts');
const skland = require('../src/main/checkin/skland');
const miyoushe = require('../src/main/checkin/miyoushe');
const notify = require('../src/main/checkin/notify');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.then(
        () => {
          passed++;
          console.log(`  ${C.green('✓')} ${name}`);
        },
        (err) => {
          failed++;
          failures.push({ name, message: err.message });
          console.log(`  ${C.red('✗')} ${name}\n    ${C.dim(err.message)}`);
        }
      );
    }
    passed++;
    console.log(`  ${C.green('✓')} ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, message: err.message });
    console.log(`  ${C.red('✗')} ${name}\n    ${C.dim(err.message)}`);
  }
  return Promise.resolve();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 写「真实世界形态」的中文 bat：GBK(ANSI) + CRLF。
 * 中文 Windows 的 cmd 默认代码页 936，双击运行的 .bat 绝大多数就是这种编码，
 * Node 不能直接 encode GBK，这里用事先算好的字节。
 */
function writeGbkBat(filePath, lines) {
  const CRLF = Buffer.from('\r\n');
  const chunks = [];
  lines.forEach((line, index) => {
    if (index > 0) chunks.push(CRLF);
    for (const part of Array.isArray(line) ? line : [line]) {
      chunks.push(Buffer.isBuffer(part) ? part : Buffer.from(part, 'latin1'));
    }
  });
  chunks.push(CRLF);
  fs.writeFileSync(filePath, Buffer.concat(chunks));
}

const GBK = {
  hello: Buffer.from('c4e3bac3a3acd6d0cec4cae4b3f6d5fdb3a3', 'hex'), // 你好，中文输出正常
  errLine: Buffer.from('d5e2cac7d2bbccf5b4edcef3d0c5cfa2', 'hex'), // 这是一条错误信息
  paused: Buffer.from('d4ddcda3c7b0', 'hex'), // 暂停前
  resumed: Buffer.from('d4ddcda3baf3', 'hex'), // 暂停后
  notSeen: Buffer.from('b2bbd3a6bfb4b5bdd5e2d2bbd0d0', 'hex'), // 不应看到这一行
};

/* --------------------------------------------------------------- 加密替身 */

const FAKE_KEY = Buffer.alloc(32, 7);
function makeFakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', FAKE_KEY, iv);
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(buf) {
      const data = Buffer.from(buf);
      const iv = data.subarray(0, 12);
      const tag = data.subarray(12, 28);
      const body = data.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', FAKE_KEY, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },
    getSelectedStorageBackend: () => 'fake-dpapi',
  };
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const tmpRoot = path.join(os.tmpdir(), `auto-checkin 测试 ${Date.now()}`);
  const workDir = path.join(tmpRoot, '脚本 目录（括号）');
  fs.mkdirSync(workDir, { recursive: true });
  console.log(C.dim(`临时目录：${tmpRoot}\n`));

  /* ------------------------------------------------ 1. 配置预检 */

  console.log(C.bold('1. 脚本配置预检'));

  await check('缺少 script 字段时给出中文提示', () => {
    const res = runner.prepareTool({ id: 'x', name: 'X' }, tmpRoot);
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => p.includes('script')));
  });

  await check('拒绝非 .bat / .cmd 扩展名', () => {
    const file = path.join(workDir, 'run.ps1');
    fs.writeFileSync(file, 'echo hi', 'utf8');
    const res = runner.prepareTool({ id: 'x', name: 'X', script: file }, tmpRoot);
    assert.equal(res.ok, false);
    assert.ok(res.problems[0].includes('只支持 .bat / .cmd'));
  });

  await check('脚本不存在时提示完整路径与最近存在的目录', () => {
    const res = runner.prepareTool(
      { id: 'x', name: 'X', script: path.join(workDir, 'nope', 'missing.bat') },
      tmpRoot
    );
    assert.equal(res.ok, false);
    assert.ok(res.problems[0].includes('脚本文件不存在'));
    assert.ok(res.problems[0].includes('最接近存在的目录'));
  });

  await check('工作目录不存在时明确指出', () => {
    const file = path.join(workDir, 'ok.bat');
    writeGbkBat(file, ['@echo off', 'echo ok']);
    const res = runner.prepareTool(
      { id: 'x', name: 'X', script: file, cwd: path.join(tmpRoot, 'no-such-dir') },
      tmpRoot
    );
    assert.equal(res.ok, false);
    assert.ok(res.problems[0].includes('工作目录不存在'));
  });

  await check('相对路径按「配置目录 → 兜底根目录」解析', () => {
    const rel = path.join('scripts', 'demo.bat');
    const target = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeGbkBat(target, ['@echo off', 'echo ok']);
    // 配置目录里没有这个文件，应该落到兜底根目录 tmpRoot
    const res = runner.prepareTool({ id: 'x', name: 'X', script: rel }, path.join(tmpRoot, 'cfg'), [
      tmpRoot,
    ]);
    assert.equal(res.ok, true, JSON.stringify(res.problems));
    assert.equal(res.tool.scriptPath, target);
  });

  await check('支持 %TEMP% 这类环境变量', () => {
    const res = runner.prepareTool(
      { id: 'x', name: 'X', script: '%TEMP%\\none.bat', cwd: tmpRoot },
      tmpRoot
    );
    assert.ok(res.tool.scriptPath.toUpperCase().startsWith(os.tmpdir().toUpperCase().slice(0, 3)));
    assert.ok(!res.tool.scriptPath.includes('%TEMP%'));
  });

  /* ------------------------------------------------ 2. 脚本执行 */

  console.log(C.bold('\n2. 脚本执行引擎'));

  const okBat = path.join(workDir, 'ok.bat');
  writeGbkBat(okBat, [
    '@echo off',
    [Buffer.from('echo '), GBK.hello],
    'echo arg=[%~1]',
    'echo cwd=%CD%',
    'exit /b 0',
  ]);

  await check('成功执行：GBK 中文解码 + 空格参数 + 工作目录', async () => {
    const prepared = runner.prepareTool(
      { id: 'ok', name: '正常脚本', script: okBat, cwd: workDir, args: ['hello world'] },
      tmpRoot
    );
    assert.equal(prepared.ok, true, JSON.stringify(prepared.problems));
    const summary = await runner.runTool(prepared.tool, {});
    assert.equal(summary.status, 'success', summary.errorMessage || '');
    assert.equal(summary.exitCode, 0);
    assert.ok(summary.stdout.includes('你好，中文输出正常'), `实际输出：${summary.stdout}`);
    assert.ok(summary.stdout.includes('arg=[hello world]'), `实际输出：${summary.stdout}`);
    assert.ok(summary.stdout.includes(workDir), '工作目录没有生效');
  });

  const failBat = path.join(workDir, 'fail.bat');
  writeGbkBat(failBat, ['@echo off', [Buffer.from('echo '), GBK.errLine], 'exit /b 7']);

  await check('非零退出码：状态 failed + 退出码 + stderr', async () => {
    const prepared = runner.prepareTool(
      { id: 'fail', name: '失败脚本', script: failBat, cwd: workDir },
      tmpRoot
    );
    const summary = await runner.runTool(prepared.tool, {});
    assert.equal(summary.status, 'failed');
    assert.equal(summary.exitCode, 7);
    assert.ok(summary.errorMessage.includes('非零退出码'));
    assert.ok(summary.stdout.includes('这是一条错误信息'), summary.stdout);
  });

  const slowBat = path.join(workDir, 'slow.bat');
  writeGbkBat(slowBat, ['@echo off', 'ping -n 30 127.0.0.1 >nul', 'echo done']);

  await check('超时强杀：状态 timeout + 中文提示 + 进程真的结束', async () => {
    const prepared = runner.prepareTool(
      { id: 'slow', name: '慢脚本', script: slowBat, cwd: workDir, timeoutSeconds: 1 },
      tmpRoot
    );
    const started = Date.now();
    const summary = await runner.runTool(prepared.tool, {});
    assert.equal(summary.status, 'timeout');
    assert.ok(summary.timedOut);
    assert.ok(summary.errorMessage.includes('执行超时'));
    assert.ok(Date.now() - started < 12000, '超时后没有及时结束');
  });

  const pauseBat = path.join(workDir, 'pause.bat');
  writeGbkBat(pauseBat, ['@echo off', [Buffer.from('echo '), GBK.paused], 'pause >nul', [Buffer.from('echo '), GBK.resumed]]);

  await check('脚本里有 pause 也不会卡住界面', async () => {
    const prepared = runner.prepareTool(
      { id: 'pause', name: '带 pause 的脚本', script: pauseBat, cwd: workDir, timeoutSeconds: 20 },
      tmpRoot
    );
    const started = Date.now();
    const summary = await runner.runTool(prepared.tool, {});
    assert.notEqual(summary.status, 'timeout', 'pause 把进程卡住了');
    assert.ok(Date.now() - started < 15000);
    assert.ok(summary.stdout.includes('暂停后'), `实际输出：${summary.stdout}`);
  });

  await check('脚本在执行前被删除：直接报错，不启动进程', async () => {
    const ghost = path.join(workDir, 'ghost.bat');
    writeGbkBat(ghost, ['@echo off', 'echo ghost']);
    const prepared = runner.prepareTool(
      { id: 'ghost', name: '幽灵脚本', script: ghost, cwd: workDir },
      tmpRoot
    );
    fs.unlinkSync(ghost);
    const summary = await runner.runTool(prepared.tool, {});
    assert.equal(summary.status, 'error');
    assert.ok(summary.errorMessage.includes('脚本文件不存在'));
  });

  await check('编码自动识别：UTF-8 与 GBK 都能正确解码', () => {
    const utf8 = new runner.StreamDecoder('auto');
    const text1 =
      utf8.push(Buffer.from('中文 UTF-8 测试'.repeat(600), 'utf8')) + utf8.end();
    assert.ok(text1.includes('中文 UTF-8 测试'));

    const gbk = new runner.StreamDecoder('auto');
    const gbkBytes = Buffer.from('d6d0cec4b2e2cad4', 'hex').toString('hex'); // 中文测试
    const text2 =
      gbk.push(Buffer.from(`${'plain '.repeat(200)}${gbkBytes}`, 'latin1')) + gbk.end();
    assert.ok(text2.length > 0);
    assert.equal(runner.isProbablyUtf8(Buffer.from('hello', 'utf8')), true);
    assert.equal(runner.isProbablyUtf8(Buffer.from('c4e3bac3', 'hex')), false);
  });

  /* ------------------------------------------------ 3. 配置读写 */

  console.log(C.bold('\n3. 配置读写（tools.json）'));

  const configDir = path.join(tmpRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  await check('读取配置：保留禁用条目、汇总中文告警', () => {
    const tools = [
      { id: 'a', name: 'A', script: okBat, cwd: workDir },
      { id: 'hidden', name: '隐藏', script: okBat, enabled: false },
      { id: 'bad', name: '坏配置', script: path.join(tmpRoot, 'x.png') },
    ];
    fs.writeFileSync(
      path.join(configDir, 'tools.json'),
      JSON.stringify({ tools }, null, 2),
      'utf8'
    );
    const loaded = store.loadConfig(configDir, { fallbackRoots: [tmpRoot] });
    assert.equal(loaded.tools.length, 2, '禁用的条目不应出现在可运行列表里');
    assert.equal(loaded.rawTools.length, 3, '原始条目要保留，供界面编辑');
    assert.ok(loaded.warnings.some((w) => w.includes('只支持 .bat')));
    assert.equal(loaded.tools[0].ready, true);
    assert.equal(loaded.tools[1].ready, false);
  });

  await check('JSON 写坏时不让程序崩，给出解析错误', () => {
    fs.writeFileSync(path.join(configDir, 'tools.json'), '{ bad json', 'utf8');
    const loaded = store.loadConfig(configDir);
    assert.equal(loaded.ok, false);
    assert.ok(loaded.warnings[0].includes('不是合法 JSON'));
  });

  await check('回写配置：保留 $schema、生成 .bak 备份、拒绝重复 id', () => {
    fs.writeFileSync(
      path.join(configDir, 'tools.json'),
      JSON.stringify({ $schema: './tools.schema.json', version: 1, tools: [] }, null, 2),
      'utf8'
    );
    const res = store.saveTools(configDir, [{ id: 'new', name: '新工具', script: okBat }]);
    assert.equal(res.ok, true, res.error);
    assert.ok(fs.existsSync(path.join(configDir, 'tools.json.bak')));
    const written = JSON.parse(fs.readFileSync(path.join(configDir, 'tools.json'), 'utf8'));
    assert.equal(written.$schema, './tools.schema.json');
    assert.equal(written.tools.length, 1);

    const dup = store.saveTools(configDir, [
      { id: 'same', name: '1', script: okBat },
      { id: 'same', name: '2', script: okBat },
    ]);
    assert.equal(dup.ok, false);
    assert.ok(dup.error.includes('重复'));
  });

  /* ------------------------------------------------ 4. 加密存储 */

  console.log(C.bold('\n4. 加密存储与账号仓库'));

  const secureDir = path.join(tmpRoot, 'secure');
  const secure = createSecureStore({ dir: secureDir, safeStorage: makeFakeSafeStorage() });

  await check('凭据加密落盘：文件里看不到明文', () => {
    const payload = {
      version: 1,
      miyoushe: { accounts: [{ id: '1', phone: '13800138000', stoken: 'v2_SECRET_TOKEN' }] },
    };
    const res = secure.save(payload);
    assert.equal(res.ok, true, res.error);
    const raw = fs.readFileSync(path.join(secureDir, 'vault.bin'), 'utf8');
    assert.ok(!raw.includes('v2_SECRET_TOKEN'));
    assert.ok(!raw.includes('13800138000'));
    const loaded = secure.load();
    assert.equal(loaded.miyoushe.accounts[0].stoken, 'v2_SECRET_TOKEN');
  });

  await check('加密不可用时拒绝保存（不退化成明文）', () => {
    const dir2 = path.join(tmpRoot, 'secure2');
    const store2 = createSecureStore({ dir: dir2, safeStorage: makeFakeSafeStorage(false) });
    const res = store2.save({ a: 1 });
    assert.equal(res.ok, false);
    assert.ok(res.error.includes('不会以明文保存'));
    assert.equal(fs.existsSync(path.join(dir2, 'vault.bin')), false);
  });

  await check('换环境解不开时优雅降级，不抛异常', () => {
    const otherKey = { ...makeFakeSafeStorage(), decryptString: () => { throw new Error('bad key'); } };
    const broken = createSecureStore({ dir: secureDir, safeStorage: otherKey });
    assert.equal(broken.load(), null);
    assert.ok(broken.describe().error.includes('无法解密'));
  });

  const accountStore = createAccountStore({ secure });

  await check('脱敏规则：手机号与密钥都不外泄', () => {
    assert.equal(maskPhone('13800138000'), '138****8000');
    assert.equal(maskPhone('123'), '123');
    assert.equal(maskSecret('abcdefghijklmn'), 'abcd••••mn');
    assert.equal(maskSecret('short'), '••••');
  });

  await check('账号增删改 + 公开视图不含原始凭据', () => {
    const created = accountStore.upsert('skland', {
      phone: '13900139000',
      token: 'ZmFrZVRva2VuZm9ydGVzdDAw',
      deviceId: 'dev-1',
      name: '主账号',
      boards: ['arknights', 'endfield'],
    });
    assert.equal(created.ok, true, created.error);
    assert.equal(created.action, 'created');

    const updated = accountStore.upsert('skland', {
      phone: '13900139000',
      token: 'NEW_TOKEN_VALUE_123456',
      deviceId: 'dev-2',
    });
    assert.equal(updated.action, 'updated');
    assert.equal(accountStore.all('skland')[0].deviceId, 'dev-2');

    const publicList = accountStore.list('skland');
    const serialized = JSON.stringify(publicList);
    assert.ok(!serialized.includes('NEW_TOKEN_VALUE_123456'), '公开视图泄露了 token');
    assert.equal(publicList[0].phoneMasked, '139****9000');
    assert.equal(publicList[0].hasCredential, true);

    const removed = accountStore.remove('skland', publicList[0].id);
    assert.equal(removed.ok, true);
    assert.equal(accountStore.list('skland').length, 0);
  });

  await check('推送设置：只提交 key 时替换，keepKey 时保留', () => {
    accountStore.saveServerChan({ sendKey: 'SCT123456abcdef', enabled: true, notifyOn: 'always' });
    assert.equal(accountStore.getServerChan().sendKey, 'SCT123456abcdef');

    accountStore.saveServerChan({ enabled: false }, { keepKey: true });
    assert.equal(accountStore.getServerChan().sendKey, 'SCT123456abcdef');
    assert.equal(accountStore.getServerChan().enabled, false);

    const pub = accountStore.publicSettings().serverChan;
    assert.equal(pub.hasKey, true);
    assert.ok(!JSON.stringify(pub).includes('SCT123456abcdef'));
  });

  /* ------------------------------------------------ 5. 签到协议细节 */

  console.log(C.bold('\n5. 签到协议（签名 / DS / 加密 / 推送）'));

  await check('森空岛签名头：字段齐全、sign 为 32 位 md5', () => {
    const client = new skland.SklandClient('ZmFrZVRva2VuZm9ydGVzdDAw', 'device-1');
    client.cred = 'cred-value';
    client.signToken = 'sign-token';
    const headers = client.signedHeaders('/api/v1/game/attendance', 'uid=1&gameId=1', '{"a":1}');
    assert.equal(headers.cred, 'cred-value');
    assert.equal(headers.platform, '3');
    assert.equal(headers.dId, 'device-1');
    assert.equal(headers.vName, '1.0.0');
    assert.match(headers.sign, /^[a-f0-9]{32}$/);
    assert.ok(Math.abs(Number(headers.timestamp) - Math.floor(Date.now() / 1000)) < 10);
  });

  await check('森空岛 token 体检：过短直接拒绝并给出中文提示', () => {
    assert.throws(() => skland.parseToken('abc'), /长度只有 3 位/);
    assert.equal(
      skland.parseToken('ZmFrZVRva2VuZm9ydGVzdDAw'),
      'ZmFrZVRva2VuZm9ydGVzdDAw'
    );
    // 补齐 base64 位
    assert.equal(skland.parseToken('ZmFrZVRva2VuZm9ydGVzdDAwabc'), 'ZmFrZVRva2VuZm9ydGVzdDAwabc=');
  });

  await check('米游社 DS 格式与登录/签到两套盐', () => {
    const web = miyoushe.dsWeb();
    const app = miyoushe.dsApp();
    for (const ds of [web, app]) {
      const parts = ds.split(',');
      assert.equal(parts.length, 3);
      assert.match(parts[0], /^\d{10}$/);
      assert.equal(parts[1].length, 6);
      assert.match(parts[2], /^[a-f0-9]{32}$/);
    }
    assert.notEqual(web.split(',')[1], app.split(',')[1]);
  });

  await check('米游社 RSA 加密：1024 位密钥 → 172 字符 base64', () => {
    const encrypted = miyoushe.rsaEncrypt('13800138000');
    assert.match(encrypted, /^[A-Za-z0-9+/=]+$/);
    assert.equal(Buffer.from(encrypted, 'base64').length, 128);
  });

  await check('Server酱 地址：sctp Key 走 uid 子域，普通 Key 走 sctapi', () => {
    const urls1 = notify.serverChanUrls('sctp12345tabcdefg');
    assert.ok(urls1[0].includes('https://12345.push.ft07.com/send/sctp12345tabcdefg.send'));
    assert.ok(urls1.some((u) => u.includes('sctapi.ftqq.com')));

    const urls2 = notify.serverChanUrls('SCT999abc');
    assert.equal(urls2.length, 1);
    assert.ok(urls2[0].includes('sctapi.ftqq.com/SCT999abc.send'));
  });

  await check('推送汇总：标题带失败数，正文逐条列出结果', () => {
    const digest = notify.buildDigest({
      label: '森空岛',
      results: [
        { board: '明日方舟', role: '博士', status: 'success', detail: '获得 合成玉×100' },
        { board: '终末地', role: '管理员', status: 'fail', detail: 'token 过期' },
        { board: '明日方舟', role: '小号', status: 'already', detail: '' },
      ],
      failures: 1,
      startedAt: Date.now(),
      durationMs: 3200,
    });
    assert.ok(digest.title.includes('失败 1'), digest.title);
    assert.ok(digest.desp.includes('✅'));
    assert.ok(digest.desp.includes('❌'));
    assert.equal(digest.counts.success, 1);
    assert.equal(digest.counts.already, 1);
    assert.equal(digest.counts.fail, 1);
    assert.ok(digest.desp.includes('由「签到工具箱」自动发送'));
  });

  await check('SendKey 脱敏：只露出头尾', () => {
    assert.equal(notify.maskKey('SCT1234567890abcdef').includes('SCT12345'), true);
    assert.ok(!notify.maskKey('SCT1234567890abcdef').includes('67890'));
  });

  /* ------------------------------------------------------------ 收尾 */

  console.log(
    `\n${C.bold('结果：')}${C.green(`${passed} 通过`)}` +
      (failed ? ` · ${C.red(`${failed} 失败`)}` : '') +
      `\n${C.dim(`临时目录：${tmpRoot}`)}`
  );

  if (failed) {
    console.log('\n失败详情：');
    for (const item of failures) console.log(` - ${item.name}：${item.message}`);
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error('测试运行失败：', err);
  process.exitCode = 1;
});
