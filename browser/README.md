# Browser 专用列表

来源：[mytv-android/China-TV-Live-M3U8/webview.m3u](https://github.com/mytv-android/China-TV-Live-M3U8/blob/main/webview.m3u)。独立存储，不参与 udpxy 转换或 FCC 处理。

仅维护 `playlist.m3u` 一份列表，每条 `webview://` 线路前重复对应 `#EXTINF`。各省卫视频道统一分组为“卫视”，央视频道保留“央视”分组；保留 EPG 和线路顺序。频道名按 `aliases/aliases.yml` 的 `browser.aliases` 统一，台标全部替换为本站的内置图片地址，优先 `aliases/logo/`，其次 `logo/`，不再使用外部图片代理。

名称映射示例（键为 Browser 显示名称或 `tvg-name`，值为 IPTV 标准名称）：

```yaml
browser:
  aliases:
    CCTV-1 综合: CCTV1
    CCTV-2 财经: CCTV2
```

生成时优先匹配显示名称，再匹配 `tvg-name`；未配置则使用上游 `tvg-name`，没有该属性时保留显示名称。映射结果同时写入 `tvg-name` 和显示名称，分组在 Mix 输出中沿用省份 IPTV。修改映射后运行 `bun run fetch:browser` 重新生成，不在服务请求时读取 YAML。

本地 Android 项目的 `M3uIptvParser.kt` 每个 `#EXTINF` 只读取第一条非注释 URL，再按分组和显示名称合并线路。因此直接导入上游原文件会忽略同一频道的第二条及后续 URL，兼容版可保留这些线路。

镜像部署更新后，在 Android 应用的自定义直播源中填写：

```text
https://你的域名/api/browser/playlist.m3u
```

此地址直接返回 Browser 列表，不经过 Mix，不需要省份或 `udpxy` 参数。

更新文件：

```bash
bun run fetch:browser
```

台标在文件中使用 `{{your_logo_address}}` 占位符，服务返回列表时按访问请求的 Host 和协议生成完整地址，支持域名或 IP:端口，无需配置部署域名。HTTPS 反向代理需保留 Host 并正确传递 `X-Forwarded-Proto`，与 IPTV 订阅的默认台标行为一致。该文件需要通过本项目服务访问，直接读取原文件不会替换占位符。

如果上游新增频道但尚无内置台标，同步会报错并保留现有列表；补充对应的 `aliases/logo/频道名.png` 后再更新。

此命令单独更新 WebView 列表；`bun run fetch:all` 仍只处理原有 IPTV 和台标数据。更新后需重新构建镜像，或者将宿主机 `browser/` 目录挂载至 `/app/browser:ro`。列表响应要求重新验证缓存，以及时反映修改和当前访问地址。

这些 URL 是网页入口，需要客户端 WebView 播放支持，普通视频播放器无法直接播放。当前 Android 项目的混合模式另从 `Constants.WEBVIEW_CHANNELS_URL` 读取 `频道名,网页地址` 格式的 TXT 映射；这与自定义 M3U 直播源入口不同，不能直接用 M3U 替换该 TXT 地址。
