#!/usr/bin/env node
/**
 * `npx create-lark-bot` — 最多两次扫码创建一个配置完整的飞书 bot 应用。
 *
 * 流程：
 *   1. 扫码① 建应用 → AppID/AppSecret（自动识别 feishu / lark 租户）
 *   2. 校验凭证（取一次 tenant_access_token）
 *   3. 扫码②（或复用 ~/.lark-bot/web-session.json 缓存，0 扫码）自动配置
 *      开放平台：导入权限（含完整 VC 会议权限）、订阅事件、按需配置
 *      redirect URL、创建并提交发布版本
 *   4. 凭证写入 ./lark-app.json（0600）；secret 默认不打印
 *
 * 参数：
 *   --out <file>          凭证输出文件（默认 ./lark-app.json）
 *   --redirect-url <url>  配置 OAuth 重定向 URL（可重复）
 *   --no-configure        跳过开放平台自动配置
 *   --no-publish          自动配置但不创建/提交发布版本
 *   --print-secret        在终端打印 AppSecret
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLarkBot } from './create-bot.js';

interface CliArgs {
  out: string;
  redirectUrls: string[];
  configure: boolean;
  publish: boolean;
  printSecret: boolean;
  help: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    out: 'lark-app.json',
    redirectUrls: [],
    configure: true,
    publish: true,
    printSecret: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') args.out = argv[++i] ?? args.out;
    else if (arg === '--redirect-url') {
      const url = argv[++i];
      if (url) args.redirectUrls.push(url);
    } else if (arg === '--no-configure') args.configure = false;
    else if (arg === '--no-publish') args.publish = false;
    else if (arg === '--print-secret') args.printSecret = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

const HELP = `create-lark-bot — 最多两次扫码创建一个配置完整的飞书 bot 应用（权限含 VC 会议智能体）

用法: npx create-lark-bot [options]

选项:
  --out <file>          凭证输出文件（默认 ./lark-app.json，权限 0600）
  --redirect-url <url>  配置 OAuth 重定向 URL（可重复传入多个）
  --no-configure        跳过开放平台自动配置（只建应用拿凭证）
  --no-publish          自动配置但不创建/提交发布版本
  --print-secret        在终端打印 AppSecret（默认只写文件）
  -h, --help            显示本帮助
`;

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());

  console.log('── 第 1 步 · 扫码创建飞书应用 ──');
  const result = await createLarkBot({
    register: { signal: ac.signal },
    autoConfigure: args.configure,
    configure: {
      redirectUrls: args.redirectUrls,
      publishVersion: args.publish,
      onStatus: message => console.log(`   ${message}`),
    },
  });

  if (!result.ok) {
    console.error(`\n❌ 应用创建失败 (${result.error}): ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.log('\n✅ 应用创建成功');
  console.log(`   App ID: ${result.appId}`);
  console.log(`   租户类型: ${result.brand === 'lark' ? 'Lark 国际版 (larksuite.com)' : '飞书 (feishu.cn)'}`);
  if (result.userOpenId) console.log(`   扫码人 open_id: ${result.userOpenId}`);

  if (result.validation) {
    if (result.validation.ok) console.log('   凭证校验: 通过 (tenant_access_token 获取成功)');
    else console.log(`   ⚠️ 凭证校验未通过 (${result.validation.error}): ${result.validation.message}`);
  }

  const conf = result.configuration;
  if (conf) {
    console.log('\n── 第 2 步 · 开放平台自动配置 ──');
    if (conf.ok) {
      console.log('✅ 自动配置完成');
      console.log(`   Session 来源: ${conf.sessionSource === 'cache' ? '缓存复用（本次 0 扫码）' : conf.sessionSource}`);
      const skipped = conf.skippedScopeCount ?? 0;
      console.log(`   已导入权限数: ${conf.scopeCount}${skipped > 0 ? `（另有 ${skipped} 项当前租户目录中没有，已跳过）` : ''}`);
      if (conf.scopeWarning) console.log(`   ⚠️ 权限注册未全部成功: ${conf.scopeWarning}`);
      console.log(`   已订阅事件数: ${conf.subscribedEventCount}${conf.eventWarning ? `（⚠️ ${conf.eventWarning}）` : ''}`);
      if (args.redirectUrls.length > 0) console.log(`   已配置 redirect URL: ${args.redirectUrls.join(', ')}`);
      if (conf.versionId) console.log(`   已提交发布版本: ${conf.versionId}`);
    } else {
      console.log(`⚠️ 自动配置失败 (${conf.reason}): ${conf.message}`);
      console.log(`   凭证已到手，可稍后到 https://open.feishu.cn/app/${result.appId} 手动完成权限/事件配置。`);
    }
  } else if (args.configure && result.brand === 'lark') {
    console.log('\n⚠️ Lark 国际版租户暂不支持开放平台自动配置，请到 open.larksuite.com 手动配置权限。');
  }

  const outPath = resolve(args.out);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        appId: result.appId,
        appSecret: result.appSecret,
        brand: result.brand,
        ...(result.userOpenId ? { userOpenId: result.userOpenId } : {}),
      },
      null,
      2,
    ) + '\n',
    { encoding: 'utf-8', mode: 0o600 },
  );
  console.log(`\n凭证已写入 ${outPath}（权限 0600）`);
  if (args.printSecret) console.log(`App Secret: ${result.appSecret}`);
  else console.log('AppSecret 未打印（需要时加 --print-secret 或查看输出文件）。');
}

main().catch(err => {
  console.error(`未预期错误: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
