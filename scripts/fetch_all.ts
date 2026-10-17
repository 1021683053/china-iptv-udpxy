/**
 * fetch_all.ts — 从上游 xisohi/CHINA-IPTV 拉取数据并生成模板
 *
 * 用法:
 *   bun run fetch            仅更新直播源（iptv/）
 *   bun run fetch:logo       仅同步上游台标（logo/）
 *   bun run fetch:all        全部更新
 *
 * 台标匹配顺序: aliases/logo/（人工补充）→ logo/（上游）→ logo_aliases 兜底 → 留空
 * 更新脚本绝不触碰 aliases/ 目录。
 */

import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '..');
const UPSTREAM = 'https://raw.githubusercontent.com/xisohi/CHINA-IPTV/main';

// ── 命令行参数 ─────────────────────────────────────────────

const mode = process.argv[2] ?? 'iptv';
if (!['iptv', 'logo', 'all'].includes(mode)) {
  console.error(`未知模式: ${mode}（可选 iptv | logo | all）`);
  process.exit(1);
}

// ── 配置加载 ───────────────────────────────────────────────

type Rules = { match: string; replace: string }[];
type Section = { aliases?: Record<string, string>; rules?: Rules; channels?: Record<string, Record<string, unknown>>; logo_aliases?: Record<string, string> };
type Config = { global: Section; provinces: Record<string, Record<string, Section>> };

const cfgPath = path.join(ROOT, 'aliases/aliases.yml');
const cfg: Config = YAML.parse(await Bun.file(cfgPath).text());
if (!cfg?.global) {
  console.error('aliases/aliases.yml 缺少 global 段');
  process.exit(1);
}

const provCfg = cfg.provinces ?? {};

/** 合并 global 与省级配置（省级覆盖同名键、追加新键） */
function mergedSection(province: string, operator: string): Required<Section> {
  const g = cfg.global;
  const p = provCfg[province]?.[operator] ?? {};
  return {
    aliases: { ...(g.aliases ?? {}), ...(p.aliases ?? {}) },
    rules: [...(g.rules ?? []), ...(p.rules ?? [])],
    channels: { ...(g.channels ?? {}), ...(p.channels ?? {}) },
    logo_aliases: { ...(g.logo_aliases ?? {}), ...(p.logo_aliases ?? {}) },
  };
}

// ── 频道名归一 ─────────────────────────────────────────────

function normalizeName(raw: string, section: Required<Section>): string {
  let name = raw.trim();
  for (const rule of section.rules) {
    const re = new RegExp(rule.match);
    if (re.test(name)) {
      name = name.replace(new RegExp(rule.match), rule.replace);
      break;
    }
  }
  return section.aliases[name] ?? name;
}

// ── 台标解析 ───────────────────────────────────────────────

const logoDir = path.join(ROOT, 'logo');
const aliasLogoDir = path.join(ROOT, 'aliases/logo');
const upstreamLogos = new Set(
  (await readdir(logoDir)).map((f) => f.replace(/\.png$/i, '')));
const aliasLogos = new Set(
  (await readdir(aliasLogoDir)).map((f) => f.replace(/\.png$/i, '')));

function resolveLogo(name: string, section: Required<Section>): string {
  if (aliasLogos.has(name)) return `aliases/logo/${name}.png`;
  if (upstreamLogos.has(name)) return `logo/${name}.png`;
  const fallback = section.logo_aliases[name];
  if (fallback) {
    if (aliasLogos.has(fallback)) return `aliases/logo/${fallback}.png`;
    if (upstreamLogos.has(fallback)) return `logo/${fallback}.png`;
  }
  return '';
}

// ── 上游解析 ───────────────────────────────────────────────

type Entry = { name: string; url: string; genre: string };

function parseTVBox(text: string): Entry[] {
  const entries: Entry[] = [];
  let genre = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const gm = line.match(/^([^,]+),#genre#$/);
    if (gm) { genre = gm[1]; continue; }
    const em = line.match(/^([^,]+),(.+)$/);
    if (em && genre) {
      const name = em[1].trim();
      const url = em[2].trim();
      // 过滤空名、空地址及非流地址行
      if (name && /^(rtp|udp|https?|rtsp):\/\//.test(url)) {
        entries.push({ name, url, genre });
      }
    }
  }
  return entries;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ── 直播源更新 ─────────────────────────────────────────────

const PROVINCES = [
  'anhui', 'beijing', 'chongqing', 'fujian', 'gansu', 'guangdong', 'guangxi',
  'guizhou', 'hainan', 'hebei', 'heilongjiang', 'henan', 'hubei', 'hunan',
  'jiangsu', 'jiangxi', 'jilin', 'liaoning', 'neimenggu', 'ningxia', 'qinghai',
  'shaanxi', 'shandong', 'shanghai', 'shanxi', 'sichuan', 'tianjin', 'xinjiang',
  'xizang', 'yunnan', 'zhejiang',
] as const;
const OPERATORS = ['telecom', 'unicom', 'mobile', 'gitv'] as const;
const SOURCES = { Multicast: 'mc', Unicast: 'uc' } as const;

/** 组播 rtp:// → udpxy 占位模板；单播地址原样 */
function convertUrl(url: string, kind: 'mc' | 'uc'): string {
  if (kind === 'mc') {
    const m = url.match(/^(?:rtp|udp):\/\/(.+)$/);
    if (!m) throw new Error(`非组播地址: ${url}`);
    return `http://{{your_udpxy_address}}/udp/${m[1]}`;
  }
  return url;
}

interface UnknownReport { province: string; operator: string; kind: string; name: string; }

async function updateIptv(): Promise<void> {
  const iptvDir = path.join(ROOT, 'iptv');
  const unknowns: UnknownReport[] = [];
  let totalFiles = 0;
  const stats: Record<string, { channels: number; logoHit: number }> = {};

  for (const province of PROVINCES) {
    for (const operator of OPERATORS) {
      for (const [upDir, kind] of Object.entries(SOURCES) as [string, 'mc' | 'uc'][]) {
        const url = `${UPSTREAM}/${upDir}/${province}/${operator}.txt`;
        let text: string;
        try {
          text = await fetchText(url);
        } catch {
          continue; // 该省无此运营商数据，跳过
        }
        const section = mergedSection(province, operator);
        const entries = parseTVBox(text)
          .map((e) => ({ ...e, name: normalizeName(e.name, section) }))
          .filter((e) => !(section.channels[e.name]?.ignore));
        if (entries.length === 0) continue;

        const dir = path.join(iptvDir, province);
        await mkdir(dir, { recursive: true });

        // TXT（TVBox 格式，保留上游分组）
        const txtLines: string[] = [];
        let lastGenre = '';
        for (const e of entries) {
          if (e.genre !== lastGenre) { txtLines.push(`${e.genre},#genre#`); lastGenre = e.genre; }
          txtLines.push(`${e.name},${convertUrl(e.url, kind)}`);
        }
        await writeFile(path.join(dir, `${operator}_${kind}.txt`), txtLines.join('\n') + '\n');

        // M3U（tvg-logo 双库匹配）
        const m3uLines = ['#EXTM3U'];
        let logoHit = 0;
        for (const e of entries) {
          const logoPath = resolveLogo(e.name, section);
          if (logoPath) logoHit++;
          const override = section.channels[e.name] ?? {};
          const group = (override.group as string) ?? e.genre;
          const logoTag = logoPath ? ` tvg-logo="{{your_logo_address}}/${logoPath}"` : ' tvg-logo=""';
          m3uLines.push(`#EXTINF:-1 tvg-id="${e.name}" tvg-name="${e.name}"${logoTag} group-title="${group}",${e.name}`);
          m3uLines.push(convertUrl(e.url, kind));
        }
        await writeFile(path.join(dir, `${operator}_${kind}.m3u`), m3uLines.join('\n') + '\n');

        totalFiles += 2;
        stats[`${province}/${operator}/${kind}`] = { channels: entries.length, logoHit };

        // 归一后仍是生僻名的，报告出来人工审
        for (const e of entries) {
          if (!upstreamLogos.has(e.name) && !aliasLogos.has(e.name) && !section.logo_aliases[e.name]) {
            unknowns.push({ province, operator, kind, name: e.name });
          }
        }
      }
    }
  }

  console.log(`已生成 ${totalFiles} 个模板文件到 iptv/`);
  // 统计概览
  let totalCh = 0, totalHit = 0;
  for (const [, s] of Object.entries(stats)) { totalCh += s.channels; totalHit += s.logoHit; }
  console.log(`频道总数: ${totalCh}, 台标命中: ${totalHit} (${(totalHit / totalCh * 100).toFixed(1)}%)`);

  // 未知频道名报告（台标未命中且无兜底映射的）
  const uniqUnknown = [...new Set(unknowns.map((u) => u.name))];
  console.log(`\n未命中台标的唯一频道名: ${uniqUnknown.length} 个`);
  await writeFile(path.join(ROOT, 'scripts/unknown_channels.report.txt'),
    uniqUnknown.sort().join('\n') + '\n');
  console.log('完整清单已写入 scripts/unknown_channels.report.txt');
}

// ── Logo 更新（仅 logo/，绝不触碰 aliases/）───────────────

async function updateLogo(): Promise<void> {
  const api = 'https://api.github.com/repos/xisohi/CHINA-IPTV/contents/logo';
  const res = await fetch(api, { headers: { 'User-Agent': 'china-iptv-udpxy' } });
  if (!res.ok) { console.error(`拉取上游清单失败: HTTP ${res.status}`); process.exit(1); }
  const files = (await res.json()) as { name: string; type: string }[];
  const pngs = files.filter((f) => f.type === 'file' && f.name.endsWith('.png')).map((f) => f.name);

  let added = 0, updated = 0;
  for (const name of pngs) {
    const local = path.join(logoDir, name);
    const url = `${UPSTREAM}/logo/${encodeURIComponent(name)}`;
    let existed = false;
    if (existsSync(local)) {
      const head = await fetch(url, { method: 'HEAD' });
      const remoteSize = Number(head.headers.get('content-length'));
      const localSize = (await Bun.file(local).arrayBuffer()).byteLength;
      if (remoteSize === localSize) continue;
      existed = true;
    }
    const data = await (await fetch(url)).arrayBuffer();
    await Bun.write(local, data);
    existed ? updated++ : added++;
  }

  // 被上游删除的台标（只报告，不删本地——保留避免历史 m3u 断链）
  const localNames = new Set<string>((await readdir(logoDir)));
  const remoteSet = new Set<string>(pngs);
  const removed = [...localNames].filter((n) => !remoteSet.has(n));
  console.log(`logo/ 同步完成: 新增 ${added}, 更新 ${updated}, 上游已删除但本地保留 ${removed.length}`);
  if (removed.length) console.log('上游已删除:', removed.join(', '));
}

// ── 主流程 ─────────────────────────────────────────────────

if (mode === 'iptv' || mode === 'all') await updateIptv();
if (mode === 'logo' || mode === 'all') await updateLogo();
console.log('完成');
