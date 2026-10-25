'use strict';

/**
 * welcome — 使用说明模块
 *
 * 纯文档型模块，用来演示「一个模块可以只是一个页面」，
 * 同时也是给第一次打开程序的人看的操作指引。
 */

let ctx = null;

function section(title, items) {
  const { el } = ctx;
  return el('section', { class: 'card' }, [
    el('h2', { text: title }),
    el(
      'ul',
      { class: 'doc-list' },
      items.map((item) => {
        if (typeof item === 'string') return el('li', { text: item });
        return el('li', {}, [
          el('b', { text: item.b }),
          item.code ? el('code', { text: item.code }) : null,
          el('span', { text: item.t }),
        ]);
      })
    ),
  ]);
}

function codeBlock(text) {
  return ctx.el('pre', { class: 'doc-code mono', text });
}

export default {
  async mount(root, moduleCtx) {
    ctx = moduleCtx;
    root.replaceChildren();
    const { el } = ctx;

    root.append(
      el('div', { class: 'doc-hero' }, [
        el('h2', { text: '一个面板，管好所有每日签到' }),
        el('p', {
          text:
            '左侧是插件化的功能面板：脚本工具负责跑本机 .bat，森空岛与米游社负责每日签到。' +
            '所有「按钮 ↔ 脚本」的对应关系、模块开关都放在 config/*.json 里，改配置或加一个页面就能扩展，不用改主流程。',
        }),
      ]),

      section('三分钟上手', [
        { b: '① 添加账号：', t: '进入「森空岛签到」或「米游社签到」，填手机号 → 获取验证码 → 登录并保存凭据。' },
        { b: '② 一键签到：', t: '点右上角或面板上的「一键签到」，日志会实时滚动，结束后显示成功/已签/失败数量。' },
        { b: '③ 微信推送：', t: '在「设置与诊断」填 Server酱 SendKey，勾选启用，可先点「发送测试推送」验证。' },
        { b: '④ 跑自己的脚本：', t: '在「脚本工具」点「新增脚本」，选 .bat、填工作目录与超时，保存即生效。' },
      ]),

      section('脚本工具怎么工作', [
        '点击卡片上的「运行」立即执行，不需要二次确认；再次点击会提示正在运行。',
        '脚本以隐藏窗口运行，标准输出与错误实时回显在卡片里，界面不会因为脚本卡住而失去响应。',
        { b: '工作目录：', t: '没填时默认用脚本所在目录，所以脚本里的相对路径（如 logs\\checkin.log）能正常用。' },
        { b: '路径兼容：', t: '含空格、中文、括号的路径都可以；配置里也支持 %USERPROFILE% 这类环境变量。' },
        { b: '超时处理：', t: '超过设定秒数会自动 taskkill 整棵进程树，状态标记「已超时」并给出中文说明。' },
        { b: '编码：', t: '默认自动识别（先 UTF-8，遇非法字节降级 GBK）；老脚本乱码时可强制指定 gbk。' },
      ]),

      section('扩展方式', [
        { b: '加一个脚本按钮：', t: '界面「新增脚本」，或直接编辑 config/tools.json，保存后点左下角「重新加载配置」。' },
        { b: '加一个功能页面：', t: '在 src/renderer/modules/ 下新建目录，放 module.json + module.js（可选 style.css），重启即出现。' },
        { b: '隐藏/排序模块：', t: '改 config/modules.json 的 order 与 modules.{id}.enabled。' },
        { b: '加系统能力：', t: '在 preload.js 加一个白名单方法 + main.js 加一个 ipcMain.handle，渲染层永远拿不到 Node 权限。' },
      ]),

      el('section', { class: 'card' }, [
        el('h2', { text: '模块目录长这样' }),
        codeBlock(`src/renderer/modules/my-module/
├─ module.json     # 清单：id / 标题 / 图标 / 入口 / 排序
├─ module.js       # export default { mount(root, ctx), unmount() }
└─ style.css       # 可选，模块私有样式`),
        el('p', {
          class: 'muted',
          text: '某个模块加载失败只会用它自己的页面显示错误，其它模块照常可用，不会整屏白屏。',
        }),
      ]),

      section('关于安全（准备开源，所以格外注意）', [
        '签到凭据（token / cookie / stoken）与 Server酱 SendKey 全部用系统级加密（Windows DPAPI）保存，文件在用户数据目录的 secure/vault.bin。',
        '凭据不会写进 config/*.json，不会出现在日志里，也不会传到界面：界面上只显示 138****8000、abcd••••xy 这类脱敏值。',
        '把 vault.bin 拷到别的电脑或别的 Windows 账户下都解不开；换账户后如果解不开，程序会提示你清空凭据重新登录。',
        '源码里没有任何硬编码的密钥、手机号或 token；发布前只需确认 config/tools.json 不含个人路径即可。',
        '若系统不提供加密能力（极少数环境），程序宁可本次不保存凭据，也不会退化成明文存储。',
      ]),

      el('section', { class: 'card' }, [
        el('h2', { text: '打成 exe' }),
        codeBlock(`cd auto-checkin
npm install
npm run dist              # 免安装单文件：release/AutoCheckin-1.0.0-portable.exe
npm run dist:installer    # 安装包：release/AutoCheckin-1.0.0-setup.exe`),
        el('p', {
          class: 'muted',
          text: '国内网络已通过 .npmrc 配好镜像；打包报符号链接错误时用管理员终端或开启开发者模式，详见 README。',
        }),
      ])
    );

    ctx.setHeader({
      title: '使用说明',
      description: '三分钟了解面板结构、脚本执行机制与安全边界',
      actions: [{ label: '打开配置目录', onClick: () => ctx.api.openConfigDir() }],
    });
  },

  async unmount() {
    ctx = null;
  },
};
