/** 名称已由 aliases.yml 在生成时统一；这里仅合并线路并输出。 */
export function mixPlaylists(iptv, browser, type = 'm3u') {
  const channels = new Map();

  // IPTV 在前，同频道沿用它的名称、分组和台标，URL 去重。
  for (const content of [iptv, browser]) {
    const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
    if (!lines[0]?.startsWith('#EXTM3U')) throw new Error('混合源必须是 M3U 列表');
    let channel;
    let tags = [];
    for (const raw of lines.slice(1)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXTINF:')) {
        const comma = line.lastIndexOf(',');
        if (comma < 0) throw new Error('混合源 EXTINF 缺少频道名');
        const name = line.slice(comma + 1).trim();
        const key = (line.match(/\btvg-name="([^"]*)"/)?.[1] || name).trim();
        const group = line.match(/\bgroup-title="([^"]*)"/)?.[1] || '其他';
        if (!channels.has(key)) channels.set(key, {
          info: `${line.slice(0, comma)},${name}`, name, group, routes: new Map(),
        });
        channel = channels.get(key);
        tags = [];
      } else if (line.startsWith('#')) {
        tags.push(line);
      } else {
        if (!channel || !/^(https?|rtsp|rtp|udp|webview):\/\//i.test(line)) throw new Error('混合源含无效频道地址');
        if (!channel.routes.has(line)) channel.routes.set(line, [...tags]);
      }
    }
  }

  // 继承 IPTV 头部，缺少 EPG 时补充 Browser 的节目单。
  let header = iptv.replace(/^\uFEFF/, '').split(/\r?\n/)[0];
  if (!/\b(x-tvg-url|url-tvg|tvg-url)=/.test(header)) {
    const epg = browser.split(/\r?\n/)[0].match(/\b(?:x-tvg-url|url-tvg|tvg-url)="[^"]*"/)?.[0];
    if (epg) header += ` ${epg}`;
  }
  const output = type === 'txt' ? [] : [header];
  let lastGroup;
  for (const channel of channels.values()) {
    if (!channel.routes.size) continue;
    if (type === 'txt' && channel.group !== lastGroup) {
      output.push(`${channel.group},#genre#`);
      lastGroup = channel.group;
    }
    for (const [url, tags] of channel.routes) {
      if (type === 'txt') output.push(`${channel.name},${url}`);
      else output.push(channel.info, ...tags, url);
    }
  }
  return output.join('\n') + '\n';
}
