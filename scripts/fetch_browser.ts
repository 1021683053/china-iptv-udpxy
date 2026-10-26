/** 单独同步 WebView 列表，保留全部线路并使用项目内置台标。 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = path.resolve(import.meta.dirname, '..');
const config = YAML.parse(await Bun.file(path.join(root, 'aliases/aliases.yml')).text());
const aliases: Record<string, string> = config?.browser?.aliases ?? {};
if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)
  || Object.values(aliases).some(name => typeof name !== 'string' || !name.trim() || /["\r\n,]/.test(name))) {
  throw new Error('browser.aliases 必须是频道名到标准名的映射');
}

function normalizeEntry(line: string): string {
  const comma = line.lastIndexOf(',');
  const display = line.slice(comma + 1).trim();
  const tvgName = line.match(/\btvg-name="([^"]+)"/)?.[1] ?? display;
  const name = Object.hasOwn(aliases, display) ? aliases[display]
    : Object.hasOwn(aliases, tvgName) ? aliases[tvgName] : tvgName;
  const header = line.slice(0, comma);
  let normalized = /\btvg-name="[^"]*"/.test(header)
    ? header.replace(/\btvg-name="[^"]*"/, () => `tvg-name="${name}"`)
    : `${header} tvg-name="${name}"`;
  if (name.endsWith('卫视')) {
    normalized = /\bgroup-title="[^"]*"/.test(normalized)
      ? normalized.replace(/\bgroup-title="[^"]*"/, 'group-title="卫视"')
      : `${normalized} group-title="卫视"`;
  }
  return `${normalized},${name}`;
}

function localLogo(entry: string): string {
  const name = entry.match(/\btvg-name="([^"]+)"/)?.[1] ?? entry.slice(entry.lastIndexOf(',') + 1).trim();
  if (!name || /[/\\]/.test(name) || name === '..') throw new Error(`台标频道名无效: ${name}`);
  for (const dir of ['aliases/logo', 'logo']) {
    const file = `${dir}/${name}.png`;
    if (existsSync(path.join(root, file))) return `{{your_logo_address}}/${file}`;
  }
  throw new Error(`缺少内置台标: ${name}；请先补充 aliases/logo/${name}.png`);
}

const upstream = 'https://raw.githubusercontent.com/mytv-android/China-TV-Live-M3U8/main/webview.m3u';
const response = await fetch(upstream, { signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error(`WebView 同步失败: HTTP ${response.status}`);
const bytes = new Uint8Array(await response.arrayBuffer());
const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
if (!lines[0]?.startsWith('#EXTM3U')) throw new Error('上游不是 M3U 文件，保留现有列表');

const output = [lines[0]];
let entry = '';
let tags: string[] = [];
let count = 0;
for (const raw of lines.slice(1)) {
  const line = raw.trim();
  if (!line) continue;
  if (line.startsWith('#EXTINF:')) {
    const logo = localLogo(line);
    const normalized = normalizeEntry(line);
    entry = /\btvg-logo="[^"]*"/.test(line)
      ? normalized.replace(/\btvg-logo="[^"]*"/, () => `tvg-logo="${logo}"`)
      : normalized.replace('#EXTINF:-1', () => `#EXTINF:-1 tvg-logo="${logo}"`);
    tags = [];
    continue;
  }
  if (line.startsWith('#')) { tags.push(line); continue; }
  if (!entry || !/^webview:\/\/https?:\/\/\S+$/.test(line)) {
    throw new Error(`无效的 WebView 条目: ${line}`);
  }
  // 当前 Android 解析器每个 EXTINF 只取一条 URL，重复元数据以保留所有线路。
  output.push(entry, ...tags, line);
  count++;
}
if (!count) throw new Error('上游没有 WebView 线路，保留现有列表');

const dir = path.join(root, 'browser');
await mkdir(dir, { recursive: true });
const target = path.join(dir, 'playlist.m3u');
await writeFile(target + '.tmp', output.join('\n') + '\n');
await rename(target + '.tmp', target);
console.log(`已保存 browser/playlist.m3u（${count} 条线路，全部使用内置台标）`);
