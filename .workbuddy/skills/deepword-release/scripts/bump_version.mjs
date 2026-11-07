#!/usr/bin/env node
/**
 * DeepWord 应用版本号发布脚本。
 *
 * 同步三个位置，并把 CHANGELOG 的 [Unreleased] 段落转成正式版本条目：
 *   - package.json 的 version
 *   - src/lib/version.ts 的 APP_VERSION
 *   - CHANGELOG.md 的 [Unreleased] → [新版本] - 日期
 *
 * 用法：
 *   node bump_version.mjs <new-version> [--date YYYY-MM-DD] [--dry-run] [--force]
 *
 * 例：
 *   node bump_version.mjs 1.2.0 --date 2026-11-07 --dry-run
 *   node bump_version.mjs 1.2.0 --date 2026-11-07
 *
 * 脚本不执行任何 git 操作；提交由 SKILL.md 的工作流负责。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `用法: node bump_version.mjs <new-version> [--date YYYY-MM-DD] [--dry-run] [--force]

  <new-version>   SemVer，例如 1.2.0 / 2.0.0 / 1.3.0-beta.1
  --date          发布日，格式 YYYY-MM-DD（建议由调用方用 date +%F 传入）
  --dry-run       只打印将发生的改动，不写文件
  --force         允许版本号不升反降或相同（默认拒绝）`;

function parseArgs(argv) {
  const opts = { version: null, date: null, dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(HELP);
      process.exit(0);
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--date') {
      opts.date = argv[++i];
      if (!opts.date) fail('--date 需要一个 YYYY-MM-DD 值');
    } else if (arg.startsWith('--')) {
      fail(`未知参数：${arg}\n\n${HELP}`);
    } else if (!opts.version) {
      opts.version = arg;
    } else {
      fail(`多余的位置参数：${arg}\n\n${HELP}`);
    }
  }
  if (!opts.version) fail(`缺少目标版本号\n\n${HELP}`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(opts.version)) {
    fail(`版本号不符合 SemVer：${opts.version}`);
  }
  if (opts.date && !/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
    fail(`日期格式必须是 YYYY-MM-DD：${opts.date}`);
  }
  if (!opts.date) {
    opts.date = new Date().toISOString().slice(0, 10);
    console.warn(`[warn] 未传 --date，使用 UTC 当天 ${opts.date}；跨时区请用 --date $(date +%F)`);
  }
  return opts;
}

function fail(message) {
  console.error(`[bump_version] ${message}`);
  process.exit(1);
}

/** 从脚本所在目录向上找 name === 'deepword' 的 package.json，定位仓库根。 */
function findRepoRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        if (JSON.parse(readFileSync(candidate, 'utf8')).name === 'deepword') return dir;
      } catch { /* 继续向上 */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  fail('找不到 DeepWord 仓库根（向上未发现 name=deepword 的 package.json）');
}

function compare(a, b) {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  // 同数字版本时，预发布视为更小
  if (a.includes('-') !== b.includes('-')) return a.includes('-') ? -1 : 1;
  return 0;
}

const opts = parseArgs(process.argv.slice(2));
const root = findRepoRoot();
const files = {
  pkg: join(root, 'package.json'),
  versionTs: join(root, 'src/lib/version.ts'),
  changelog: join(root, 'CHANGELOG.md'),
};

for (const [key, path] of Object.entries(files)) {
  if (!existsSync(path)) fail(`缺少必需文件（${key}）：${path}`);
}

const rawPkg = readFileSync(files.pkg, 'utf8');
const pkg = JSON.parse(rawPkg);
const oldVersion = pkg.version;
if (typeof oldVersion !== 'string') fail('package.json 缺少 version 字段');
if (!opts.force && compare(opts.version, oldVersion) <= 0) {
  fail(`新版本 ${opts.version} 必须大于当前版本 ${oldVersion}（如需降级请加 --force）`);
}

const changes = [];
function update(label, path, transform) {
  const before = readFileSync(path, 'utf8');
  const after = transform(before);
  if (after === before) fail(`${label} 未发生任何变化，可能文件格式已变，请人工检查：${path}`);
  changes.push({ label, path, before, after });
  if (!opts.dryRun) writeFileSync(path, after);
}

// 1) package.json：保留 2 空格缩进与末尾换行习惯
update('package.json', files.pkg, (raw) => {
  const obj = JSON.parse(raw);
  obj.version = opts.version;
  const trailing = raw.endsWith('\n') ? '\n' : '';
  return JSON.stringify(obj, null, 2) + trailing;
});

// 2) src/lib/version.ts：只替换 APP_VERSION 的字符串值
update('src/lib/version.ts', files.versionTs, (raw) => {
  const pattern = /export const APP_VERSION = '[^']*'/;
  if (!pattern.test(raw)) fail('src/lib/version.ts 中找不到 APP_VERSION 声明');
  return raw.replace(pattern, `export const APP_VERSION = '${opts.version}'`);
});

// 3) CHANGELOG.md：把 [Unreleased] 的内容发布为新版本，并留下空的 Unreleased。
update('CHANGELOG.md', files.changelog, (raw) => {
  const header = '## [Unreleased]\n';
  const at = raw.indexOf(header);
  if (at < 0) fail('CHANGELOG.md 缺少 ## [Unreleased] 段落');
  const body = raw.slice(at + header.length);
  const firstLine = body.trimStart().split('\n')[0].trim();
  if (firstLine === '暂无。' || firstLine === '') {
    fail('[Unreleased] 没有可发布的条目，请先在 CHANGELOG.md 补写变更内容');
  }
  const replacement =
    `## [Unreleased]\n\n暂无。\n\n---\n\n## [${opts.version}] - ${opts.date}\n`;
  return raw.slice(0, at) + replacement + body;
});

const mode = opts.dryRun ? '[dry-run] ' : '';
console.log(`${mode}DeepWord 版本 ${oldVersion} → ${opts.version}（发布日 ${opts.date}）`);
for (const change of changes) {
  const rel = change.path.slice(root.length + 1);
  console.log(`${mode}${opts.dryRun ? '将更新' : '已更新'} ${rel}`);
}
if (opts.dryRun) {
  console.log('\n--- CHANGELOG.md 预览（前 24 行）---');
  console.log(changes.at(-1).after.split('\n').slice(0, 24).join('\n'));
} else {
  console.log('\n下一步：复核以上 3 个文件 → 跑 pnpm typecheck / test / build → git add + commit。');
}
