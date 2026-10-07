#!/usr/bin/env node
/**
 * `npx create-lark-bot [create|update|verify] [options]`
 *
 * create (default): one QR scan (zero with a cached session) creates a Feishu app with your
 *   name / description / avatar, reads AppID/AppSecret, configures scopes / events / callbacks /
 *   redirect URLs and publishes. `--compat` (or `--brand lark`) uses the official SDK device flow.
 * update: pick an existing app (`--app-id` or `--select`), read its secret, optionally change its
 *   identity, re-apply the configuration.
 * verify: official-API checks (credentials, bot capability, granted scopes, optional live WS).
 *
 * Secrets are never printed (unless --print-secret) nor included in --json output.
 */
import { createInterface } from 'node:readline/promises';
import { realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLarkBot, updateLarkBot, type CreateLarkBotResult, type UpdateLarkBotResult } from './create-bot.js';
import type { ConfigureAppResult } from './open-platform.js';
import { readCredentialsFile, updateEnvFile, writeCredentialsFile, type StoredCredentials } from './output.js';
import { isPresetName, PRESET_NAMES, type BotPreset, type PresetName } from './presets.js';
import type { RegisterBrand } from './register-app.js';
import { verifyLarkBot, type VerifyReport } from './verify.js';

export interface CliArgs {
  command: 'create' | 'update' | 'verify';
  name?: string;
  desc?: string;
  avatar?: string;
  brand?: RegisterBrand;
  mode?: 'auto' | 'console' | 'sdk';
  fallback: boolean;
  presets: string[];
  scopes: string[];
  userScopes: string[];
  events: string[];
  callbacks: string[];
  redirectUrls: string[];
  configure: boolean;
  publish: boolean;
  switchAccount: boolean;
  noQr: boolean;
  sessionFile?: string;
  qrOut?: string;
  out?: string;
  writeEnv?: string;
  envOwnerVar?: string;
  ownerPrefix: string;
  printSecret: boolean;
  json: boolean;
  owner: boolean;
  appId?: string;
  select: boolean;
  credentials?: string;
  live: boolean;
  help: boolean;
  errors: string[];
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: 'create', fallback: true, presets: [], scopes: [], userScopes: [], events: [], callbacks: [], redirectUrls: [],
    configure: true, publish: true, switchAccount: false, noQr: false, ownerPrefix: '', printSecret: false, json: false,
    owner: true, select: false, live: false, help: false, errors: [],
  };
  let i = 0;
  if (argv[0] && ['create', 'update', 'verify'].includes(argv[0])) {
    args.command = argv[0] as CliArgs['command'];
    i = 1;
  }
  const value = (flag: string): string | undefined => {
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) {
      args.errors.push(`${flag} 需要一个参数`);
      if (v !== undefined) i -= 1;
      return undefined;
    }
    return v;
  };
  const list = (flag: string, into: string[]) => {
    const v = value(flag);
    if (v) into.push(...v.split(',').map(s => s.trim()).filter(Boolean));
  };
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--name': args.name = value(arg); break;
      case '--desc': case '--description': args.desc = value(arg); break;
      case '--avatar': args.avatar = value(arg); break;
      case '--brand': {
        const b = value(arg);
        if (b === 'feishu' || b === 'lark') args.brand = b;
        else if (b) args.errors.push('--brand 只能是 feishu 或 lark');
        break;
      }
      case '--mode': {
        const m = value(arg);
        if (m === 'auto' || m === 'console' || m === 'sdk') args.mode = m;
        else if (m) args.errors.push('--mode 只能是 auto / console / sdk');
        break;
      }
      case '--compat': args.mode = 'sdk'; break;
      case '--no-fallback': args.fallback = false; break;
      case '--preset': case '--presets': list(arg, args.presets); break;
      case '--scope': list(arg, args.scopes); break;
      case '--user-scope': list(arg, args.userScopes); break;
      case '--event': list(arg, args.events); break;
      case '--callback': list(arg, args.callbacks); break;
      case '--redirect-url': { const v = value(arg); if (v) args.redirectUrls.push(v); break; }
      case '--no-configure': args.configure = false; break;
      case '--no-publish': args.publish = false; break;
      case '--switch-account': args.switchAccount = true; break;
      case '--no-qr': args.noQr = true; break;
      case '--session-file': args.sessionFile = value(arg); break;
      case '--qr-out': args.qrOut = value(arg); break;
      case '--out': case '--write-credentials': args.out = value(arg); break;
      case '--write-env': args.writeEnv = value(arg); break;
      case '--env-owner-var': args.envOwnerVar = value(arg); break;
      case '--owner-prefix': args.ownerPrefix = value(arg) ?? ''; break;
      case '--print-secret': args.printSecret = true; break;
      case '--json': args.json = true; break;
      case '--no-owner': args.owner = false; break;
      case '--app-id': args.appId = value(arg); break;
      case '--select': args.select = true; break;
      case '--credentials': args.credentials = value(arg); break;
      case '--live': args.live = true; break;
      case '-h': case '--help': args.help = true; break;
      default: args.errors.push(`未知参数: ${arg}`);
    }
  }
  for (const p of args.presets) if (!isPresetName(p)) args.errors.push(`未知 preset: ${p}（可选: ${PRESET_NAMES.join(', ')}）`);
  if (args.envOwnerVar && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(args.envOwnerVar)) args.errors.push('--env-owner-var 必须是合法的环境变量名');
  return args;
}

export const HELP = `create-lark-bot — 一次扫码创建 / 更新 / 校验飞书（Lark）机器人应用

用法:
  create-lark-bot [create] [options]     新建应用（默认）
  create-lark-bot update   [options]     更新已有应用（--app-id <cli_xxx> 或 --select）
  create-lark-bot verify   [options]     用官方 API 校验（--app-id/--credentials，或读 LARK_APP_ID/LARK_APP_SECRET/LARK_DOMAIN）

身份:
  --name <name>           应用名（默认 lark-bot，重名自动加 -2/-3…；支持 {user}）
  --desc <text>           应用描述（支持 {user}）
  --avatar <file|url>     头像：本地文件或 http(s) URL（控制台路径要求 512×512 PNG ≤2MB；
                          兼容模式只接受 URL）

流程:
  --brand feishu|lark     lark = 国际版，走 SDK device flow
  --mode auto|console|sdk 默认 auto：控制台一次扫码，失败且未建出应用时回退 SDK
  --compat                等同 --mode sdk（官方 SDK device flow，appPreset + addons）
  --no-fallback           auto 模式下不回退 SDK
  --switch-account        忽略缓存登录态，重新扫码（换账号）
  --no-qr                 只复用缓存登录态，绝不弹二维码
  --session-file <file>   Web 登录态缓存（默认 ~/.lark-bot/web-session.json，0600）
  --qr-out <file>         另把二维码内容写入文件（0600），供无法显示终端二维码的环境自行渲染

权限 / 事件:
  --preset a,b            组合 preset（${PRESET_NAMES.join(', ')}）；默认 messaging,contact,selfManage,vcMeeting,userLogin
  --scope s1,s2           追加 tenant 权限      --user-scope s   追加 user 权限
  --event e1,e2           追加事件              --callback c     追加回调
  --redirect-url <url>    OAuth 重定向 URL（可重复；与线上已有地址合并，不会删除）
  --no-configure          不做开放平台配置      --no-publish     配置但不发版

输出:
  --out <file>            凭证 JSON（0600，目录 0700）；create 默认 ./lark-app.json（给了 --write-env 时不写），update 只在显式指定时写
  --write-env <file>      就地更新 LARK_APP_ID / LARK_APP_SECRET / LARK_DOMAIN（不打印值）
  --env-owner-var <NAME>  同时把已验证的 owner union_id 合并写入该变量（逗号列表）
  --owner-prefix <p>      写入 owner 时加前缀（如 "lark-bot:"）
  --json                  stdout 输出机器可读结果（不含 secret），人类可读信息走 stderr
  --print-secret          在终端打印 AppSecret
  --no-owner              不解析扫码人身份

verify:
  --credentials <file>    读取凭证 JSON         --live   再启动 WebSocket 探测长连接
`;

export interface CliIO {
  out: (text: string) => void;
  err: (text: string) => void;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  signal?: AbortSignal;
  /** Test seams. */
  createLarkBot?: typeof createLarkBot;
  updateLarkBot?: typeof updateLarkBot;
  verifyLarkBot?: typeof verifyLarkBot;
  prompt?: (question: string) => Promise<string>;
}

function buildPresets(args: CliArgs): Array<PresetName | BotPreset> | undefined {
  const extra: BotPreset = {
    scopes: { tenant: args.scopes, user: args.userScopes },
    events: { app: args.events },
    callbacks: args.callbacks,
  };
  const hasExtra = args.scopes.length + args.userScopes.length + args.events.length + args.callbacks.length > 0;
  if (args.presets.length === 0 && !hasExtra) return undefined;
  const base: PresetName[] = args.presets.length > 0
    ? (args.presets as PresetName[])
    : ['messaging', 'contact', 'selfManage', 'vcMeeting', 'userLogin'];
  return [...base, ...(hasExtra ? [extra] : [])];
}

function configureSummary(conf: ConfigureAppResult | undefined, log: (s: string) => void, appId: string): void {
  if (!conf) return;
  if (!conf.ok) {
    log(`⚠️ 开放平台配置未完成 (${conf.reason}): ${conf.message}`);
    if (conf.reason === 'session_expired') log('   登录态已失效：加 --switch-account 重新扫码后用 update 重试。');
    log(`   凭证已到手，可稍后到 https://open.feishu.cn/app/${appId} 手动补齐，或运行 create-lark-bot update --app-id ${appId}`);
    return;
  }
  log('✅ 开放平台配置完成');
  log(`   导入权限 ${conf.scopeCount} 项${conf.skippedScopeCount ? `（${conf.skippedScopeCount} 项租户目录中没有，已跳过）` : ''}`);
  if (conf.droppedScopes.length) log(`   已移除会被自动驳回的权限: ${conf.droppedScopes.join(', ')}`);
  if (conf.scopeWarning) log(`   ⚠️ 权限注册: ${conf.scopeWarning}`);
  if (conf.privilegeRangeCount) log(`   已把 ${conf.privilegeRangeCount} 项数据范围设为「与应用的可用范围一致」`);
  if (conf.privilegeRangeWarning) log(`   ⚠️ 数据范围: ${conf.privilegeRangeWarning}`);
  log(`   事件/回调已确认 ${conf.subscribedEventCount} 项${conf.eventWarning ? `（⚠️ ${conf.eventWarning}）` : ''}`);
  if (!conf.redirectConfigured) log(`   ⚠️ redirect URL: ${conf.redirectWarning ?? '未生效'}`);
  if (conf.publishSkipped) log('   配置无变化，未发新版本');
  else if (conf.versionId) {
    log(`   已提交版本 ${conf.versionId}${conf.versionReused ? '（提交了已存在的草稿）' : ''}`);
    if (conf.approvalAutoPassed === true) log('   审批：自动通过');
    else if (conf.approvalHumanApprovers?.length) log(`   审批：需要 ${conf.approvalHumanApprovers.join('、')} 审批`);
  }
  if (conf.versionWarning) log(`   ⚠️ ${conf.versionWarning}`);
}

function persist(
  args: CliArgs,
  creds: StoredCredentials,
  ownerUnionId: string | undefined,
  log: (s: string) => void,
  command: 'create' | 'update',
): { credentialsFile?: string; envFile?: string } {
  const written: { credentialsFile?: string; envFile?: string } = {};
  if (args.writeEnv) {
    const vars: Record<string, string | undefined> = {
      LARK_APP_ID: creds.appId,
      LARK_APP_SECRET: creds.appSecret,
      LARK_DOMAIN: creds.brand,
    };
    if (args.envOwnerVar && ownerUnionId) vars[args.envOwnerVar] = `${args.ownerPrefix}${ownerUnionId}`;
    const envPath = resolve(args.writeEnv);
    updateEnvFile(envPath, vars, { mergeListKeys: args.envOwnerVar ? [args.envOwnerVar] : [] });
    log(`已更新 ${envPath}（${Object.keys(vars).filter(k => vars[k] !== undefined).join(', ')}；权限 0600）`);
    if (args.envOwnerVar && !ownerUnionId) log(`⚠️ 没有已验证的 owner union_id，未写入 ${args.envOwnerVar}`);
    written.envFile = envPath;
  }
  // A new app's secret must land somewhere, so create defaults to ./lark-app.json.
  // update only reads an existing app: it writes credentials only when asked to.
  if (args.out || (command === 'create' && !args.writeEnv)) {
    const outPath = resolve(args.out ?? 'lark-app.json');
    writeCredentialsFile(outPath, creds);
    log(`凭证已写入 ${outPath}（权限 0600）`);
    written.credentialsFile = outPath;
  }
  return written;
}

/** Secret-free JSON view of a create/update result. */
export function resultJson(result: CreateLarkBotResult | UpdateLarkBotResult, extra: Record<string, unknown> = {}): Record<string, unknown> {
  if (!result.ok) return { ...result, ...extra };
  const { appSecret: _secret, validation, ...rest } = result;
  const safeValidation = validation
    ? (validation.ok ? { ok: true, tokenExpiresIn: validation.tokenExpiresIn } : validation)
    : undefined;
  return { ...rest, ...(safeValidation ? { validation: safeValidation } : {}), ...extra };
}

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const args = parseCliArgs(argv);
  if (args.help) {
    io.out(HELP);
    return 0;
  }
  if (args.errors.length) {
    for (const e of args.errors) io.err(`❌ ${e}`);
    io.err('运行 create-lark-bot --help 查看用法。');
    return 2;
  }
  const log = (s: string) => (args.json ? io.err(s) : io.out(s));
  const presets = buildPresets(args);
  const session = {
    ...(args.sessionFile ? { sessionFilePath: resolve(args.sessionFile) } : {}),
    ...(args.switchAccount ? { forceQrLogin: true } : {}),
    ...(args.noQr ? { disableQrLogin: true } : {}),
    onStatus: (m: string) => io.err(`   ${m}`),
    ...(args.qrOut
      ? {
          onQrCode: (info: { qrText: string; qrPayload: string }) => {
            io.err('\n请用飞书 App 扫码登录飞书开放平台（创建 / 配置应用只需这一次）：\n');
            io.err(info.qrText);
            writeQrOut(args.qrOut!, info.qrPayload);
            io.err(`二维码内容已写入 ${args.qrOut}`);
          },
        }
      : {}),
  };
  const register = args.qrOut
    ? {
        onQRCodeReady: (info: { url: string; expireIn: number }) => {
          io.err(`\n请用飞书 App 扫码完成应用创建：\n  ${info.url}`);
          writeQrOut(args.qrOut!, info.url);
          io.err(`二维码内容已写入 ${args.qrOut}`);
        },
      }
    : undefined;
  const identity = {
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.desc !== undefined ? { description: args.desc } : {}),
    ...(args.avatar !== undefined ? { avatar: args.avatar } : {}),
  };
  const configure = { redirectUrls: args.redirectUrls, publishVersion: args.publish };

  if (args.command === 'verify') {
    let creds: Pick<StoredCredentials, 'appId' | 'appSecret' | 'brand'>;
    try {
      if (args.credentials) creds = readCredentialsFile(resolve(args.credentials));
      else {
        const appId = args.appId ?? io.env.LARK_APP_ID;
        const appSecret = io.env.LARK_APP_SECRET;
        if (!appId || !appSecret) throw new Error('缺少凭证：传 --credentials <file>，或设置 LARK_APP_ID 与 LARK_APP_SECRET');
        creds = { appId, appSecret, brand: args.brand ?? (io.env.LARK_DOMAIN === 'lark' ? 'lark' : 'feishu') };
      }
    } catch (err) {
      io.err(`❌ ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
    const report: VerifyReport = await (io.verifyLarkBot ?? verifyLarkBot)({
      appId: creds.appId,
      appSecret: creds.appSecret,
      brand: args.brand ?? creds.brand,
      live: args.live,
      ...(presets ? { presets } : {}),
    });
    if (args.json) io.out(JSON.stringify(report, null, 2));
    else {
      io.out(`${report.ok ? '✅' : '❌'} ${report.appId} (${report.brand})`);
      for (const c of report.checks) io.out(`  [${c.status}] ${c.id}: ${c.detail}${c.link ? `\n          ${c.link}` : ''}`);
      if (report.missingScopes.length) {
        io.out('\n缺少的权限可在开放平台「权限管理 → 批量导入」粘贴：');
        io.out(JSON.stringify(report.scopesJson, null, 2));
      }
    }
    return report.ok ? 0 : 1;
  }

  const ac = new AbortController();
  if (io.signal) io.signal.addEventListener('abort', () => ac.abort(), { once: true });

  if (args.command === 'update') {
    if (!args.appId && !args.select) {
      io.err('❌ update 需要 --app-id <cli_xxx> 或 --select');
      return 2;
    }
    const prompt = io.prompt;
    const result = await (io.updateLarkBot ?? updateLarkBot)({
      appId: args.appId,
      ...(args.mode === 'sdk' ? { mode: 'sdk' as const } : {}),
      ...(args.brand ? { brand: args.brand } : {}),
      ...(Object.keys(identity).length ? { identity } : {}),
      ...(presets ? { presets } : {}),
      session,
      register: { signal: ac.signal, ...register },
      configure,
      autoConfigure: args.configure,
      resolveOwner: args.owner,
      allowRescan: io.isTTY && prompt
        ? async detail => /^y/i.test((await prompt(`飞书登录态已失效（${detail}）。重新扫码？[y/N] `)).trim())
        : false,
      ...(args.select && prompt
        ? {
            pick: async apps => {
              apps.forEach((a, idx) => io.err(`  ${idx + 1}. ${a.name} (${a.clientId})`));
              const n = Number.parseInt((await prompt('选择应用序号（回车取消）: ')).trim(), 10);
              return Number.isFinite(n) && n >= 1 && n <= apps.length ? apps[n - 1].clientId : null;
            },
          }
        : {}),
    });
    return finish(args, io, log, result, 'update');
  }

  log('── 创建飞书 / Lark 机器人应用 ──');
  const result = await (io.createLarkBot ?? createLarkBot)({
    ...(Object.keys(identity).length ? { identity } : {}),
    ...(args.brand ? { brand: args.brand } : {}),
    ...(args.mode ? { mode: args.mode } : {}),
    fallbackToSdk: args.fallback,
    ...(presets ? { presets } : {}),
    session,
    register: { signal: ac.signal, ...register },
    configure,
    autoConfigure: args.configure,
    resolveOwner: args.owner,
  });
  return finish(args, io, log, result, 'create');
}

function finish(
  args: CliArgs,
  io: CliIO,
  log: (s: string) => void,
  result: CreateLarkBotResult | UpdateLarkBotResult,
  command: 'create' | 'update',
): number {
  if (!result.ok) {
    io.err(`❌ ${command === 'create' ? '创建' : '更新'}失败 [${result.stage}/${result.error}]: ${result.message}`);
    if ('appId' in result && result.appId) io.err(`   应用 ${result.appId} 已创建；请运行 create-lark-bot update --app-id ${result.appId} 恢复，不要重复创建。`);
    if (args.json) io.out(JSON.stringify(resultJson(result), null, 2));
    return 1;
  }
  log(`\n✅ ${command === 'create' ? '应用已创建' : '已选择应用'}: ${result.appId}（${result.brand === 'lark' ? 'Lark 国际版' : '飞书'}，${result.source === 'console' ? '控制台流程' : 'SDK 兼容模式'}）`);
  if ('identity' in result && result.identity && 'name' in result.identity && result.identity.name) log(`   名称: ${result.identity.name}`);
  if (result.sessionIdentity) log(`   飞书账号: ${result.sessionIdentity.userName} · ${result.sessionIdentity.tenantName}`);
  if (result.validation) {
    log(result.validation.ok ? '   凭证校验: 通过' : `   ⚠️ 凭证校验未通过 (${result.validation.error}): ${result.validation.message}`);
  }
  if (result.owner) {
    log(result.owner.status === 'verified'
      ? `   owner: union_id ${result.owner.unionId}（已经新应用验证）`
      : `   ⚠️ owner 未验证 (${result.owner.status}): ${result.owner.reason ?? ''}`);
  }
  configureSummary(result.configuration, log, result.appId);
  if ('identityUpdate' in result && result.identityUpdate) {
    const u = result.identityUpdate;
    log(u.ok ? `   身份更新: ${u.changed.length ? u.changed.join(', ') : '无变化'}` : `   ⚠️ 身份更新失败: ${u.message}`);
  }
  for (const w of result.warnings) log(`⚠️ ${w}`);

  const ownerUnionId = result.owner?.verified.unionId ? result.owner.unionId : undefined;
  const written = persist(args, {
    appId: result.appId,
    appSecret: result.appSecret,
    brand: result.brand,
    ...('userOpenId' in result && result.userOpenId ? { userOpenId: result.userOpenId } : {}),
    ...(result.owner && (result.owner.unionId || result.owner.openId)
      ? { owner: { unionId: result.owner.unionId, openId: result.owner.openId, verified: result.owner.verified } }
      : {}),
  }, ownerUnionId, log, command);
  if (args.printSecret) log(`App Secret: ${result.appSecret}`);
  else if (written.credentialsFile || written.envFile) log('AppSecret 未打印（见输出文件；需要时加 --print-secret）。');
  if (args.json) io.out(JSON.stringify(resultJson(result, written), null, 2));
  const configFailed = result.configuration && !result.configuration.ok;
  return configFailed ? 3 : 0;
}

function isMain(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  const isTTY = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const rl = isTTY ? createInterface({ input: process.stdin, output: process.stderr }) : undefined;
  runCli(process.argv.slice(2), {
    out: s => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`),
    err: s => process.stderr.write(s.endsWith('\n') ? s : `${s}\n`),
    env: process.env,
    isTTY,
    signal: ac.signal,
    ...(rl ? { prompt: (q: string) => rl.question(q) } : {}),
  })
    .then(code => { process.exitCode = code; })
    .catch(err => {
      process.stderr.write(`未预期错误: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(() => rl?.close());
}

function writeQrOut(path: string, payload: string): void {
  writeFileSync(resolve(path), payload + '\n', { encoding: 'utf-8', mode: 0o600 });
}
