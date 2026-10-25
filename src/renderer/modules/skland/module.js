'use strict';

/**
 * skland — 森空岛签到模块
 *
 * 界面与交互都在 lib/checkin-panel.js 里，这里只声明「我是谁、签哪些板块」。
 * 想加一个同类签到平台？复制这个文件改配置即可，不需要动主流程。
 */

import { createCheckinModule } from '../../lib/checkin-panel.js';

export default createCheckinModule({
  kind: 'skland',
  title: '森空岛',
  subtitle: '明日方舟 / 明日方舟：终末地 每日签到',
  accent: '#0f9b8e',
  accent2: '#35c9b4',
  avatarText: '森',
  loginTitle: '添加森空岛账号',
  loginHint:
    '登录只需手机号 + 短信验证码；成功后程序会自动换取 token 并加密保存，之后可一键签到，无需再登录。token 失效时删掉账号重新添加即可。',
  boards: [
    { code: 'arknights', label: '明日方舟' },
    { code: 'endfield', label: '终末地' },
  ],
});
