# create-lark-bot

最多**两次扫码**创建一个配置完整的飞书（Lark）bot 应用。

> 本库基于 [botmux](https://github.com/deepcoldy/botmux)（MIT License）的建 bot 流程抽取而来——扫码建应用（Device Flow）、飞书 Web 登录态、开放平台自动配置等核心实现均源自 botmux 的 `src/setup/` 模块，在此致谢。

- **扫码① 建应用**：OAuth 2.0 Device Flow（`@larksuiteoapi/node-sdk` 的 `registerApp`），终端二维码扫一下即拿到 AppID/AppSecret，自动识别飞书 / Lark 国际版租户
- **扫码② 自动配置**：飞书 Web 扫码登录后调开放平台 console 接口，自动完成：
  - **权限导入**——默认清单包含 bot 收发消息、通讯录基础、应用自查，以及**完整 VC 会议智能体权限**（入会/离会、实时语音发言、会中消息、会中事件流、会议 AI 辅助）
  - **事件订阅**——消息基线事件 + `vc.bot.*` 会议事件（替换式接口，自动全量提交）
  - 按需配置 OAuth 重定向 URL
  - 创建版本并提交发布
- Web session 私有缓存（`~/.lark-bot/web-session.json`，0600）——同机再建 bot 时**第二步 0 扫码**

## CLI

```bash
npx create-lark-bot
# 凭证写入 ./lark-app.json（0600），secret 默认不打印

npx create-lark-bot --redirect-url http://127.0.0.1:9768/callback --out my-bot.json
npx create-lark-bot --no-configure     # 只建应用拿凭证
npx create-lark-bot --no-publish      # 配置但不发版
```

## 编程 API

```ts
import { createLarkBot } from 'create-lark-bot';

const result = await createLarkBot({
  configure: { redirectUrls: ['http://127.0.0.1:9768/callback'] },
});
if (result.ok) {
  console.log(result.appId);          // cli_xxx
  // result.appSecret — 妥善保管，勿写日志
  // result.configuration — 开放平台自动配置结果（失败不影响拿到凭证）
}
```

细粒度 API（各步骤可独立使用）：

```ts
import {
  registerLarkApp,            // 扫码① 建应用
  prepareWebSession,          // 扫码②/缓存 Web session
  configureOpenPlatformApp,   // 权限 + 事件 + redirect + 发版
  createOpenPlatformApiClient,
  listOpenPlatformApps,       // 列出已有自建应用
  fetchOpenPlatformAppSecret, // 读取已有应用的 secret（只读，绝不 reset）
  validateCredentials,        // tenant_access_token 校验
  DEFAULT_SCOPE_MANIFEST,     // 默认权限（含完整 VC）
  VC_MEETING_TENANT_SCOPES,
  DEFAULT_EVENTS,
} from 'create-lark-bot';
```

自定义权限清单：

```ts
import { createLarkBot, DEFAULT_SCOPE_MANIFEST } from 'create-lark-bot';

await createLarkBot({
  configure: {
    scopeManifest: {
      scopes: {
        tenant: [...DEFAULT_SCOPE_MANIFEST.scopes!.tenant!, 'docx:document:create'],
        user: DEFAULT_SCOPE_MANIFEST.scopes!.user,
      },
    },
  },
});
```

## 注意事项

- 开放平台自动配置仅支持**飞书（feishu.cn）租户**；Lark 国际版会自动跳过并提示手动配置
- 权限注册是非致命步骤：个别租户目录里不可授予的权限会导致整批被拒，此时只记 warning，redirect / 发版仍会完成，可稍后到开放平台手动补齐
- 事件订阅接口是**替换式**的——通过 `events` 自定义时必须传全量列表，漏掉的事件会被退订
- secret 安全：AppSecret 不打印、不进日志与错误链；凭证文件与 session 文件均 0600

## 开发

```bash
pnpm install
pnpm build   # tsc
pnpm test    # vitest
```
