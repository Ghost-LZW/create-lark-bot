# create-lark-bot

**一次扫码**（有缓存登录态时 0 扫码）创建一个配置完整、名称/描述/头像由你决定的飞书（Lark）机器人应用；也能更新已有应用、用官方 API 校验应用。

> 本库基于 [botmux](https://github.com/deepcoldy/botmux)（MIT License）的建 bot 流程抽取而来——飞书 Web 登录态、开放平台控制台自动化、SDK device flow 等核心实现均源自 botmux 的 `src/setup/` 模块，在此致谢。

## 流程

**主路径（飞书 feishu.cn）——单个 Web session 完成全部步骤：**

1. 飞书 Web 扫码登录（`~/.lark-bot/web-session.json` 缓存，0600，目录 0700；之后 0 扫码）
2. 用你给的名称 / 描述 / 头像在开放平台控制台创建应用（一键智能体模板，被明确拒绝时回退普通自建应用；结果未知时绝不重建，避免重复应用）
3. 只读获取 AppID / AppSecret（绝不调用 secret reset）
4. 配置：权限导入、权限「数据范围」收敛为「与应用的可用范围一致」、机器人能力 + 长连接、事件订阅（按应用/用户身份分桶）、卡片回调 `card.action.trigger`、可选 OAuth 重定向 URL（与线上已有地址合并，不删除）、可选可见范围追加
5. 创建并提交版本：可见范围原样镜像线上版本；存在未提交草稿时提交草稿；提交后回读确认；预判审批是否自动通过；审核中（code=10046）单独报告，不自动撤回
6. 解析扫码人身份：经**新应用**的通讯录 API 换成 union_id（标明哪些 id 已验证）

**兼容路径（官方 SDK device flow）**：`--compat` / `mode: 'sdk'`、Lark 国际版租户（`--brand lark`），以及控制台路径在创建任何应用之前失败时自动回退。名称/描述/头像 URL 走 SDK `appPreset`，权限/事件/回调走 SDK `addons`（需平台灰度开启才生效）；飞书租户随后仍会在 Web session 上完成控制台配置。

## CLI

```bash
npx create-lark-bot --name "Ops Helper" --desc "{user} 的运维助手" --avatar ./icon.png
#   → 凭证写入 ./lark-app.json（0600）；AppSecret 默认不打印

npx create-lark-bot --preset messagingCore,contact --scope docx:document:readonly --redirect-url http://127.0.0.1:3000/callback
npx create-lark-bot --write-env .env --env-owner-var MY_BOT_OWNERS --json   # 就地更新 LARK_APP_ID/LARK_APP_SECRET/LARK_DOMAIN
npx create-lark-bot --compat --avatar https://example.com/icon.png          # 官方 SDK device flow
npx create-lark-bot --brand lark                                            # Lark 国际版

npx create-lark-bot update --select --name "New Name"        # 列出已有应用并选择；改名并重新配置
npx create-lark-bot update --app-id cli_xxx --avatar ./new.png
npx create-lark-bot verify --credentials lark-app.json --live # 官方 API 校验 + WebSocket 探测
```

| 参数 | 说明 |
|---|---|
| `--name <name>` | 应用名。默认 `lark-bot`，重名时自动 `lark-bot-2`、`-3`…。支持 `{user}`（扫码人姓名） |
| `--desc <text>` | 应用描述，默认 `A Feishu/Lark bot.`。支持 `{user}` |
| `--avatar <file\|url>` | 头像。控制台路径：**512×512 PNG、≤2MB**（与 botmux 在控制台上验证过的唯一形态一致；URL 会先下载再校验上传）。兼容模式：只接受公网可访问的 URL（png/jpg/jpeg/webp/gif），本地文件会被忽略并给出 warning。不传时控制台路径使用内置的中性图标，SDK 路径使用平台默认 |
| `--brand feishu\|lark` | `lark` 走 SDK 流程（控制台自动化只支持 feishu.cn） |
| `--mode auto\|console\|sdk`, `--compat`, `--no-fallback` | 选择流程；auto 失败（且未建出应用）时回退 SDK |
| `--switch-account` / `--no-qr` / `--session-file` | 强制重新扫码 / 只用缓存不弹码 / 自定义缓存路径 |
| `--preset a,b` | 组合 preset（见下）；默认 `messaging,contact,selfManage,vcMeeting,userLogin` |
| `--scope`, `--user-scope`, `--event`, `--callback` | 在 preset 之上追加 |
| `--redirect-url <url>` | OAuth 重定向 URL（可重复） |
| `--no-configure`, `--no-publish` | 跳过控制台配置 / 配置但不发版 |
| `--out <file>` | 凭证 JSON（0600，目录 0700）。默认 `./lark-app.json`；只给 `--write-env` 时不写 |
| `--write-env <file>` | 就地更新 `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_DOMAIN`（=`feishu`/`lark`），保留其它行，0600，不打印值 |
| `--env-owner-var <NAME>`, `--owner-prefix <p>` | 把**已验证的** owner union_id（加前缀）合并写入该变量（逗号列表） |
| `--json` | stdout 输出机器可读结果（不含 secret / token），人类可读信息走 stderr |
| `--print-secret` | 在终端打印 AppSecret |
| `--no-owner` | 不解析扫码人身份 |
| `update --app-id <id> \| --select` | 更新已有应用；登录态失效时（TTY）询问是否重新扫码 |
| `verify [--credentials f \| --app-id] [--live]` | 未给文件时读 `LARK_APP_ID`/`LARK_APP_SECRET`/`LARK_DOMAIN` |

退出码：0 成功；1 失败；2 参数错误；3 应用已创建但控制台配置未完成。

## 编程 API

```ts
import { createLarkBot, updateLarkBot, verifyLarkBot } from 'create-lark-bot';

const r = await createLarkBot({
  identity: { name: 'Ops Helper', description: "{user}'s helper", avatar: './icon.png' }, // 或 URL / Uint8Array
  presets: ['messagingCore', 'contact', { scopes: { tenant: ['docx:document:readonly'] } }],
  configure: { redirectUrls: ['http://127.0.0.1:3000/callback'] },
});
if (r.ok) {
  r.appId; r.appSecret;          // 妥善保管，勿写日志
  r.source;                      // 'console' | 'sdk'
  r.owner;                       // { unionId?, openId?, verified: { unionId, openId }, status: 'verified' | 'unverified' | 'unresolved' }
  r.configuration;               // 控制台配置结果（失败不影响拿到凭证）
} else if (r.appId) {
  // 应用已经建出来但后续失败：用 updateLarkBot({ appId: r.appId }) 恢复，不要重复创建
}

await updateLarkBot({ appId: 'cli_xxx', identity: { name: 'Renamed' }, allowRescan: true });
const report = await verifyLarkBot({ appId, appSecret, presets: ['messagingCore'], live: true });
```

### Presets

```ts
import { presets, composePresets } from 'create-lark-bot';
const manifest = composePresets('messagingCore', 'vcMeeting', { events: { app: ['im.message.updated_v1'] } });
```

| preset | 内容 |
|---|---|
| `messagingCore` | `im:message:send_as_bot`、`im:message`、`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`；事件 `im.message.receive_v1`；回调 `card.action.trigger` |
| `messaging` | core + `im:message.group_msg`、`im:resource`、表情回复、群管理、cardkit…；事件含入群/退群/表情/成员变更/消息编辑 |
| `contact` | 通讯录基础读取（`contact:user.base:readonly`、`contact:user.id:readonly`…）——owner 解析需要 |
| `selfManage` | `application:application:self_manage`（`verify` 回读已授权权限需要，免审批） |
| `vcMeeting` | 完整 VC 会议智能体权限 + `vc.bot.*`（应用身份）+ `vc.meeting.participant_meeting_joined_v1`（用户身份） |
| `userLogin` | OAuth 用户登录基础 user 权限 |
| `docs` / `wiki` / `sheets` / `base` / `calendar` / `tasks` / `urgent` / `chatTabs` / `feedGroups` | 对应能力 |
| `full` | botmux 当前完整清单（tenant 170 / user 129），审批面大 |

`DEFAULT_SCOPE_MANIFEST`、`DEFAULT_EVENTS`、`DEFAULT_CALLBACKS`、`FULL_SCOPE_MANIFEST` 等常量仍然导出。飞书会「自动驳回」的 5 个权限（`AUTO_REJECTED_SCOPES`）即使出现在自定义清单里也会被剔除并报告。

### 细粒度 API

`createFeishuOpenPlatformApp`、`configureOpenPlatformApp`、`selectExistingApp`、`updateOpenPlatformAppIdentity`、`registerLarkApp`（SDK，支持 `appPreset` / `addons` / `appId` / `createOnly`）、`resolveOwnerIdentity`、`verifyLarkBot`、`prepareWebSession`、`createOpenPlatformApiClient`、`listOpenPlatformApps`、`fetchOpenPlatformAppSecret`、`writeCredentialsFile`、`updateEnvFile`，以及 payload builder / parser（`buildEventSubscriptionPayload`、`parseOnlineVisibility`、`predictApprovalFlow`、`cancelPendingReviewVersion`…）。

## 注意事项

- 控制台自动化使用开放平台**内部**接口（`/developers/v1/*`，与 botmux 相同），只支持飞书 feishu.cn 租户；接口变动时可改用 `--compat`。
- 事件 / 回调使用控制台的增量契约（`operation: 'add'`）：先读现状，只补缺失项，再回读确认；已订阅的事件不会被退订。`im.message.receive_v1` 与 `card.action.trigger` 回读缺失时判失败（`event_verification_failed`）。
- 登录态「半失效」（页面还能拿到 csrf，接口返回 `please log in again` / 4101）会以 `session_expired` 返回；CLI 中可加 `--switch-account` 重新扫码，库中可传 `allowRescan` 或 `session.forceQrLogin`。
- 发版时可见范围原样镜像线上版本（读不懂时中止发版，绝不把应用从别人面前收走）；配置无变化时不发版。
- secret 安全：AppSecret / tenant token 不打印、不进日志、错误信息与 `--json` 输出；凭证文件、`.env`、session 文件均 0600。
- `verify` 只用官方 API；事件订阅没有官方查询接口，因此总是 `unknown` 并给出控制台链接（`--live` 可用 WebSocket 实测）。

## 从 0.1.x 升级

见 [CHANGELOG](./CHANGELOG.md#020)。主要变化：默认流程由「SDK 扫码 + Web 扫码」两次扫码改为控制台单次扫码；`DEFAULT_EVENTS` 不再包含 `card.action.trigger`（改为 `DEFAULT_CALLBACKS`）；`ConfigureAppResult` 字段与失败原因有扩展。

## 开发

```bash
pnpm install
pnpm build   # tsc
pnpm test    # vitest（全部用 fake fetch / mock，无网络）
```
