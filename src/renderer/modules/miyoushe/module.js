'use strict';

/**
 * miyoushe — 米游社签到模块
 *
 * 与森空岛共用 lib/checkin-panel.js 的交互，仅平台配置不同。
 */

import { createCheckinModule } from '../../lib/checkin-panel.js';

export default createCheckinModule({
  kind: 'miyoushe',
  title: '米游社',
  subtitle: '崩坏：星穹铁道 / 绝区零 每日签到',
  accent: '#5a5bef',
  accent2: '#8a7bff',
  avatarText: '米',
  loginTitle: '添加米游社账号',
  loginHint:
    '登录只需手机号 + 短信验证码，成功后自动获取并加密保存 stoken / cookie_token。首次绑定某款游戏时，需要先在米游社 App 里手动签到一次，之后才能自动签到。若提示人机验证，请稍后重试或用 App 手动签到。',
  boards: [
    { code: 'sr', label: '星穹铁道' },
    { code: 'zzz', label: '绝区零' },
  ],
});
