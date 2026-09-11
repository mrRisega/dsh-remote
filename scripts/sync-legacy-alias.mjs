#!/usr/bin/env node
/**
 * 灰度兼容：把 packages/dsh-remote-web（正式包）同步生成一份旧名别名包
 * packages/dsh-remote-ui，使插件市场里“旧条目”（url 指向 packages/dsh-remote-ui）
 * 在新名审核通过前依旧可安装，且用户装到的是同一份最新代码（当前 0.6.2）。
 *
 * 用法:
 *   node scripts/sync-legacy-alias.mjs           # 生成/刷新别名包
 *   node scripts/sync-legacy-alias.mjs --check    # 只校验是否同步（CI/check 用）
 *
 * 说明:
 *   - 别名包是“自包含副本”（默认 pnpm 从 git 子目录安装时不会带上目录外的文件，
 *     所以不能靠相对路径 re-export）。
 *   - 名称/插件 id 改回 dsh-remote-ui，保证与市场旧条目、老用户 profile 一致。
 *   - 新名条目合并通过后：删除 packages/dsh-remote-ui、停发 dsh-remote-ui ，
 *     并向目录提交旧条目移除 PR（见 skill: dsh-plugin-market-publish）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'packages/dsh-remote-web')
const DST = join(ROOT, 'packages/dsh-remote-ui')
const CHECK = process.argv.includes('--check')

/** 必须命中的替换（命中不到即报错，避免静默漂移）。 */
const SUBS = {
  'lib/index.js': [
    ['const PLUGIN_ID = "dsh-remote-web";', 'const PLUGIN_ID = "dsh-remote-ui";'],
    ['const PLUGIN_LEGACY_IDS = ["dsh-remote-ui"];', 'const PLUGIN_LEGACY_IDS = ["dsh-remote-web"];'],
  ],
  'lib/client.js': [
    ['id: "dsh-remote-web",', 'id: "dsh-remote-ui",'],
    ['setAttribute("data-plugin", "dsh-remote-web")', 'setAttribute("data-plugin", "dsh-remote-ui")'],
  ],
  'cordis.patch.yml': [
    ['- id: dsh-remote-web', '- id: dsh-remote-ui'],
    ["name: 'dsh-remote-web'", "name: 'dsh-remote-ui'"],
  ],
}

const problems = []
const written = []

function readSrc(rel) {
  return readFileSync(join(SRC, rel), 'utf8')
}
function emit(rel, content) {
  const abs = join(DST, rel)
  mkdirSync(dirname(abs), { recursive: true })
  const prev = existsSync(abs) ? readFileSync(abs, 'utf8') : null
  if (prev === content) return
  if (CHECK) {
    problems.push(`${rel} 与 packages/dsh-remote-web 不同步（运行 npm run sync:alias 修复）`)
    return
  }
  writeFileSync(abs, content)
  written.push(rel)
}

const pkg = JSON.parse(readSrc('package.json'))
const aliasPkg = {
  ...pkg,
  name: 'dsh-remote-ui',
  description:
    '【兼容别名包】dsh-remote 旧名 dsh-remote-ui 的别名，功能与 dsh-remote-web 完全一致（同一份代码同步生成）。' +
    ' Legacy alias of dsh-remote-web — identical build, kept installable while the renamed entry is pending review. ' +
    pkg.description,
  repository: { ...pkg.repository, directory: 'packages/dsh-remote-ui' },
  homepage: 'https://github.com/mrRisega/dsh-remote/tree/main/packages/dsh-remote-ui#readme',
}
emit('package.json', JSON.stringify(aliasPkg, null, 2) + '\n')

for (const [rel, pairs] of Object.entries(SUBS)) {
  let text = readSrc(rel)
  for (const [from, to] of pairs) {
    if (!text.includes(from)) {
      problems.push(`${rel} 中未找到待替换片段：${from}（源包结构可能已变，请更新 sync 脚本）`)
      continue
    }
    text = text.split(from).join(to)
  }
  if (rel === 'cordis.patch.yml') {
    text = text.replace(/^# dsh-remote-web/m, '# dsh-remote-ui（旧名别名，同步自 dsh-remote-web）')
  }
  emit(rel, text)
}

// 截图清单与 README 直接跟随
emit('screenshots.json', readSrc('screenshots.json'))
emit(
  'README.md',
  `> ⚠️ **兼容别名包（dsh-remote-ui）**：本目录由 \`npm run sync:alias\` 从 \`packages/dsh-remote-web\` 自动生成，\n` +
    `> 用于旧名条目在改名审核通过前继续可装。请勿手改——改源包后重新生成。\n\n` +
    readSrc('README.md')
)

if (problems.length) {
  console.error('✖ 别名包校验/生成失败：')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
if (CHECK) {
  console.log('✔ 旧名别名包 packages/dsh-remote-ui 与 packages/dsh-remote-web 已同步')
} else {
  console.log(
    written.length
      ? `✔ 已同步别名包（${written.length} 个文件）：${written.join(', ')}`
      : '✔ 别名包已是最新，无需改动'
  )
}
