/**
 * china-iptv-udpxy 订阅服务（零依赖，Node.js >= 18，ESM）
 *
 * 路由:
 *   GET /api/subscribe/:province/:operator/:source/:type
 *   GET /api/mix/:province/:operator/:source/:type （省份 IPTV + Browser）
 *        province = 省份拼音（anhui…zhejiang，共 31 省）
 *        operator = telecom | unicom | mobile | gitv
 *        source   = mc（组播）| uc（单播）
 *        type     = m3u | txt
 *   查询参数:
 *        udpxy   组播必填，内网 IPv4:端口，可带路径前缀（udpxy 不解析域名）
 *        logo    可选，自定义台标服务器地址（默认跟随当前访问域名）
 *        fcc     仅组播，追加 FCC 服务器地址到流 URL
 *        nocache 拒绝缓存
 *   GET /*  静态托管（iptv/、logo/、aliases/logo/ 台标等）
 *
 * 模板: iptv/{province}/{operator}_{mc|uc}.{m3u|txt}
 * 启动时扫描 iptv/ 生成可用省份/运营商清单，未提供的组合返回 404。
 */

'use strict';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mixPlaylists } from './playlist.mjs';

const PORT = Number(process.env.PORT) || 8080;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IPTV_DIR = path.join(ROOT, 'iptv');

// ── 可用省份/运营商（启动时扫描 iptv/ 生成）────────────────

const available = new Set(); // `${province}/${operator}/${source}`
for (const prov of fs.readdirSync(IPTV_DIR, { withFileTypes: true })) {
  if (!prov.isDirectory()) continue;
  for (const f of fs.readdirSync(path.join(IPTV_DIR, prov.name))) {
    const m = f.match(/^(telecom|unicom|mobile|gitv)_(mc|uc)\.(m3u|txt)$/);
    if (m) available.add(`${prov.name}/${m[1]}/${m[2]}`);
  }
}

// ── 校验工具 ───────────────────────────────────────────────

const DOMAIN_RE = /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

function isValidIPv4(s) {
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d+$/.test(p) && !(p.length > 1 && p[0] === '0')
    && Number(p) <= 255);
}

function isPrivateIPv4(s) {
  if (!isValidIPv4(s)) return false;
  const [a, b] = s.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** 保留反向代理路径前缀，兼容用户附带的协议头和末尾 /udp、/rtp。 */
function normalizeUDPXY(s) {
  return s.replace(/^https?:\/\//, '').replace(/\/+$/, '')
    .replace(/\/(?:udp|rtp)$/, '').replace(/\/+$/, '');
}

/** udpxy: 内网 IPv4:端口，可带安全的路径前缀，不接受 query/fragment。 */
function isValidUDPXY(s) {
  const slash = s.indexOf('/');
  const authority = slash < 0 ? s : s.slice(0, slash);
  const prefix = slash < 0 ? '' : s.slice(slash);
  if (!/^[A-Za-z0-9._~%/-]*$/.test(prefix) || /%(?![0-9a-f]{2})/i.test(prefix)) return false;
  const decoded = prefix.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  if (!/^[A-Za-z0-9._~/-]*$/.test(decoded)
    || decoded.split('/').some((part) => part === '.' || part === '..')) return false;
  const idx = authority.lastIndexOf(':');
  if (idx <= 0) return false;
  const port = authority.substring(idx + 1);
  if (!/^\d+$/.test(port)) return false;
  const n = Number(port);
  return n >= 1 && n <= 65535 && isPrivateIPv4(authority.substring(0, idx));
}

/** fcc: 任意合法 IPv4:端口 */
function isValidFCC(s) {
  const idx = s.lastIndexOf(':');
  if (idx <= 0) return false;
  const port = s.substring(idx + 1);
  if (!/^\d+$/.test(port)) return false;
  const n = Number(port);
  return n >= 1 && n <= 65535 && isValidIPv4(s.substring(0, idx));
}

/** logo: IPv4 或域名，可带端口 */
function isValidLogoHost(s) {
  const idx = s.lastIndexOf(':');
  const host = idx > 0 ? s.substring(0, idx) : s;
  return isValidIPv4(host) || DOMAIN_RE.test(host);
}

/** 给 HTTP(S) 流地址行追加 query 参数 */
function appendQueryParam(content, name, value) {
  return content.split(/(\r?\n)/).map((line) => {
    const m = line.match(/^(.*?,)?(https?:\/\/.*)$/i);
    if (!m) return line;
    const base = m[2].split('#')[0];
    const frag = m[2].includes('#') ? m[2].substring(m[2].indexOf('#')) : '';
    return `${m[1] || ''}${base}${base.includes('?') ? '&' : '?'}${name}=${value}${frag}`;
  }).join('');
}

// ── 订阅处理 ───────────────────────────────────────────────

function handleSubscribe(province, operator, source, type, params, req, res, mix = false) {
  const jsonError = (msg, code = 400) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ code, message: msg }));
  };

  if (!available.has(`${province}/${operator}/${source}`)) {
    return jsonError('未找到该省份/运营商/数据源组合，请检查 iptv/ 目录下的可用数据');
  }
  if (type !== 'm3u' && type !== 'txt') {
    return jsonError('参数无效，仅支持 m3u 或 txt');
  }

  const udpxy = params.get('udpxy') || '';
  const fcc = params.get('fcc') || '';
  const logo = params.get('logo') || '';
  const noCache = params.has('nocache');
  const udpxyResolved = normalizeUDPXY(udpxy);

  if (source === 'mc') {
    if (!udpxy) return jsonError('组播的udpxy参数为必填');
    if (!isValidUDPXY(udpxyResolved)) {
      return jsonError('udpxy参数格式无效，应为内网 IP:端口，可带路径前缀（如 192.168.x.x:5140/app/rtp2httpd）');
    }
  } else if (udpxy) {
    return jsonError('udpxy参数仅在 source=mc 时有效');
  }

  if (source === 'uc' && fcc) return jsonError('fcc 参数仅在 source=mc 时有效');
  if (fcc && !isValidFCC(fcc)) {
    return jsonError('fcc 参数格式无效，应为 IP:端口');
  }

  if (logo && !isValidLogoHost(logo.replace(/^https?:\/\//, ''))) {
    return jsonError('logo 参数格式无效，应为 IP或域名，可带端口');
  }

  const filePath = path.join(IPTV_DIR, province, `${operator}_${source}.${mix ? 'm3u' : type}`);
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return jsonError(`读取模板文件失败: ${filePath}`, 500);
  }

  // 占位符替换，保留 udpxy 的反向代理路径前缀。
  const logoBase = logo
    ? `http://${logo.replace(/^https?:\/\//, '')}`  // 自定义台标服务器，统一补协议头
    : `${requestProto(req)}://${req.headers.host}`;
  content = content.replace(/\{\{your_udpxy_address\}\}/g, udpxyResolved);
  content = content.replace(/\{\{your_logo_address\}\}/g, logoBase);

  if (source === 'mc' && fcc) {
    content = appendQueryParam(content, 'fcc', fcc);
  }

  if (mix) {
    try {
      const browser = fs.readFileSync(path.join(ROOT, 'browser/playlist.m3u'), 'utf8')
        .replace(/\{\{your_logo_address\}\}/g, () => logoBase);
      content = mixPlaylists(content, browser, type);
    } catch (err) {
      console.error('混合列表生成失败:', err.message);
      return jsonError('混合列表生成失败，请检查省份和 Browser 的 M3U 文件', 500);
    }
  }

  res.writeHead(200, {
    'Content-Type': type === 'm3u' ? 'audio/x-mpegurl; charset=utf-8' : 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="${province}_${operator}_${source}${mix ? '_mix' : ''}.${type}"`,
    'Cache-Control': noCache ? 'no-cache' : 'public, max-age=300',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(content);
}

// ── 静态托管 ───────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.m3u': 'audio/x-mpegurl; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.xml': 'text/xml; charset=utf-8',
  '.gz': 'application/gzip',
  '.md': 'text/markdown; charset=utf-8',
};

function handleBrowserPlaylist(req, res) {
  let content;
  try {
    content = fs.readFileSync(path.join(ROOT, 'browser/playlist.m3u'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return sendJSON(res, 404, { code: 404, message: '未找到 Browser 列表' });
    throw err;
  }
  const logoBase = `${requestProto(req)}://${req.headers.host}`;
  content = content.replace(/\{\{your_logo_address\}\}/g, () => logoBase);
  res.writeHead(200, {
    'Content-Type': MIME['.m3u'],
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'Vary': 'Host, X-Forwarded-Proto',
  });
  res.end(content);
}

function serveStatic(pathname, res) {
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const abs = path.join(ROOT, safe);

  if (!abs.startsWith(ROOT + path.sep)) {
    return sendJSON(res, 403, { code: 403, message: '禁止访问' });
  }
  // 屏蔽：点文件/.git、脚本、服务源码、依赖、配置
  const segs = safe.split(path.sep);
  if (segs.some((s) => s === '.git' || s.startsWith('.'))
    || abs.startsWith(path.join(ROOT, 'scripts') + path.sep)
    || abs.startsWith(path.join(ROOT, 'server') + path.sep)
    || abs.startsWith(path.join(ROOT, 'node_modules') + path.sep)) {
    return sendJSON(res, 403, { code: 403, message: '禁止访问' });
  }

  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return sendJSON(res, 404, { code: 404, message: '未找到' });
  }
  if (stat.isDirectory()) {
    return sendJSON(res, 404, { code: 404, message: '未找到' });
  }

  res.writeHead(200, {
    'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=3600',
  });
  fs.createReadStream(abs).pipe(res);
}

// ── 主服务 ─────────────────────────────────────────────────

function requestProto(req) {
  return (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const pathname = decodeURIComponent(u.pathname);

    if (pathname === '/api/browser/playlist.m3u' || pathname === '/browser/playlist.m3u') {
      return handleBrowserPlaylist(req, res);
    }

    const m = pathname.match(/^\/api\/(subscribe|mix)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (m) {
      handleSubscribe(m[2], m[3], m[4], m[5], u.searchParams, req, res, m[1] === 'mix');
      return;
    }
    serveStatic(pathname, res);
  } catch (err) {
    sendJSON(res, 500, { code: 500, message: `内部错误: ${err.message}` });
  }
});

server.listen(PORT, () => {
  console.log(`china-iptv-udpxy 订阅服务已启动: http://0.0.0.0:${PORT}`);
  console.log(`可用数据: ${available.size} 个 省/运营商/数据源 组合`);
});
