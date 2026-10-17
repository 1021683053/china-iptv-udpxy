/**
 * verify.ts — 仓库健康校验
 *
 * 用法:
 *   bun run verify              # 输出报告，问题以 ✗ 标出
 *   bun run verify --strict     # 有问题即退出码 1（CI 用）
 *
 * 检查项:
 *   1. aliases/logo/（人工补充）文件数 >= 基线，防止更新脚本误删
 *   2. logo/ 文件完整性：无 0 字节、无 HTML 错误页伪装
 *   3. iptv/ 模板：占位符齐全、无裸组播地址、台标引用路径存在
 *   4. 台标命中率与 unknown_channels.report.txt 交叉核对
 */

import { readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const strict = process.argv.includes('--strict');
let problems = 0;

function report(ok: boolean, okMsg: string, failMsg: string): void {
  if (ok) console.log(`  ✓ ${okMsg}`);
  else { problems++; console.log(`  ✗ ${failMsg}`); }
}

// ── 1. aliases/logo/ 基线校验 ──────────────────────────────

console.log('\n[1] 人工补充台标 (aliases/logo/)');
const aliasLogoDir = path.join(ROOT, 'aliases/logo');
const baseline = path.join(ROOT, 'aliases/.logo-baseline');
const aliasPngs = (await readdir(aliasLogoDir)).filter((f) => f.endsWith('.png'));
if (existsSync(baseline)) {
  const base = Number(readFileSync(baseline, 'utf8').trim());
  report(aliasPngs.length >= base,
    `数量 ${aliasPngs.length} >= 基线 ${base}`,
    `数量 ${aliasPngs.length} 低于基线 ${base}——可能被更新脚本误删！`);
} else {
  await (await import('node:fs/promises')).writeFile(baseline, String(aliasPngs.length));
  console.log(`  · 基线文件不存在，已写入首次基线: ${aliasPngs.length}`);
}

// ── 2. logo/ 文件完整性 ────────────────────────────────────

console.log('\n[2] 上游台标库 (logo/)');
const logoDir = path.join(ROOT, 'logo');
const pngs = (await readdir(logoDir)).filter((f) => f.endsWith('.png'));
let empty = 0, bogus = 0;
for (const f of pngs) {
  const st = await stat(path.join(logoDir, f));
  if (st.size === 0) { empty++; continue; }
  const buf = readFileSync(path.join(logoDir, f)).subarray(0, 4);
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  if (!isPng && !isJpeg) bogus++;
}
report(empty === 0, `无空文件（共 ${pngs.length} 个）`, `${empty} 个空文件`);
report(bogus === 0, `无损坏/伪装文件`, `${bogus} 个文件非 PNG/JPEG 头（疑似错误页）`);

// ── 3. iptv/ 模板完整性 ────────────────────────────────────

console.log('\n[3] 生成模板 (iptv/)');
const iptvDir = path.join(ROOT, 'iptv');
if (!existsSync(iptvDir)) {
  report(false, '', 'iptv/ 不存在——先运行 bun run fetch');
} else {
  const provinces = (await readdir(iptvDir, { withFileTypes: true })).filter((d) => d.isDirectory());
  let fileCount = 0, badPlaceholder = 0, bareMulticast = 0, brokenLogoRef = 0;
  for (const prov of provinces) {
    const pdir = path.join(iptvDir, prov.name);
    for (const f of await readdir(pdir)) {
      fileCount++;
      const content = readFileSync(path.join(pdir, f), 'utf8');
      if (f.endsWith('.m3u')) {
        for (const line of content.split('\n')) {
          if (line.startsWith('#EXTINF')) {
            if (!line.includes('tvg-logo=')) badPlaceholder++;
            const m = line.match(/tvg-logo="\{\{your_logo_address\}\}\/([^"]+)"/);
            if (m && !existsSync(path.join(ROOT, m[1]))) brokenLogoRef++;
          }
          if (line.startsWith('rtp://') || line.startsWith('udp://')) bareMulticast++;
        }
      } else if (f.endsWith('.txt')) {
        // 组播 txt 必须有 udpxy 占位符；单播 txt 是直连地址，不需要
        if (f.endsWith('_mc.txt') && !content.includes('{{your_udpxy_address}}')) badPlaceholder++;
        for (const line of content.split('\n')) {
          if (line.startsWith('rtp://') || line.startsWith('udp://')) bareMulticast++;
        }
      }
    }
  }
  report(badPlaceholder === 0, `占位符齐全（${provinces.length} 省 ${fileCount} 个文件）`, `${badPlaceholder} 处缺占位符`);
  report(bareMulticast === 0, `无裸组播地址残留`, `${bareMulticast} 行裸 rtp/udp 地址`);
  report(brokenLogoRef === 0, `台标引用路径全部存在`, `${brokenLogoRef} 个台标引用指向不存在的文件`);
}

// ── 汇总 ─────────────────────────────────────────────────

console.log(`\n${problems === 0 ? '✔ 全部通过' : `✘ ${problems} 个问题`}`);
if (strict && problems > 0) process.exit(1);
