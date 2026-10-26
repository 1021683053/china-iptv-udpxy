# china-iptv-udpxy

基于 [xisohi/CHINA-IPTV](https://github.com/xisohi/CHINA-IPTV) 数据的全国 IPTV 组播 udpxy 代理订阅服务。

## 定位

- **不是**又一个频道数据仓库——数据来自上游，本仓库负责把组播 `rtp://` 地址转成可播放的 udpxy 订阅链接
- 频道名使用上游原名，经 `aliases.yml` 归一（同台不同名 → 统一标准名）
- 台标以通用频道台标库为基础，匹配不到的留空，不伪造

## 目录结构（规划）

```
server/              # 零依赖 Node 订阅服务（多省份路由 + 静态托管）
scripts/             # fetch_all.ts（Bun + TS）：拉取上游全部省份，生成 iptv/
iptv/                # 各省模板产物（提交入库，约 1-2MB）
logo/                # 上游台标库（996 个 PNG，跟随上游更新，不被人工修改）
aliases/             # 人工补充区（独立管理）
  ├── aliases.yml    # 频道名归一与扩展配置（唯一人工维护点）
  └── logo/          # 补充台标（44 个：CGTN 全名系、浙江地方台等上游没有的）
package.json         # yaml 依赖；bun run fetch 一键更新数据
```

台标查找顺序：频道名归一 → `aliases/logo/*.png` 补充 → `logo/*.png` 上游 → `logo_aliases` 兜底映射 → 留空。

## 订阅 API

```
GET /api/subscribe/{province}/{operator}/{source}/{type}
```

| 参数 | 取值 | 说明 |
|---|---|---|
| `province` | `anhui`…`zhejiang` 共 31 省 | 省份拼音 |
| `operator` | `telecom` \| `unicom` \| `mobile` \| `gitv` | 运营商 |
| `source` | `mc` \| `uc` | 组播 / 单播 |
| `type` | `m3u` \| `txt` | 输出格式 |
| `udpxy` | 内网 IPv4:端口[/路径前缀] | **组播必填**，udpxy 或 rtp2httpd 转发地址 |
| `logo` | IP或域名[:端口] | 可选，自定义台标服务器（默认跟随访问域名） |
| `fcc` | IP:端口 | 仅组播，追加 FCC 服务器 |
| `nocache` | - | 拒绝缓存 |

示例：

```
# 浙江电信组播（udpxy 部署在路由器 192.168.1.1:4022）
http://{your_server_address}/api/subscribe/zhejiang/telecom/mc/m3u?udpxy=192.168.1.1:4022

# 安徽电信单播直连
http://{your_server_address}/api/subscribe/anhui/telecom/uc/txt

# 自定义台标服务器
http://{your_server_address}/api/subscribe/sichuan/telecom/mc/m3u?udpxy=192.168.1.1:4022&logo=192.168.1.2:8080

# rtp2httpd 带路径前缀
https://example.com/api/subscribe/zhejiang/telecom/mc/m3u?udpxy=192.168.30.100:5140/app/rtp2httpd&fcc=115.233.40.137:8027
```

带前缀时，生成的频道地址形如 `http://192.168.30.100:5140/app/rtp2httpd/udp/233.50.201.118:5140?fcc=115.233.40.137:8027`。rtp2httpd 或反向代理必须实际提供该前缀。`udpxy` 不接受查询参数或片段；兼容输入末尾的 `/udp`、`/rtp`，生成时避免重复。

部署：

```bash
node server/server.mjs          # Node >= 18，默认 8080
docker compose -f server/docker-compose.yml up -d --build
```

## GitHub 自动构建与镜像部署

推送到 `main` 后，GitHub Actions 会先校验数据，再构建并发布 `linux/amd64`、`linux/arm64` 镜像：

```bash
docker run -d --name china-iptv-udpxy --restart unless-stopped \
  -p 8080:8080 ghcr.io/1021683053/china-iptv-udpxy:latest
```

浏览器访问 `http://服务器地址:8080`。镜像包含仓库内的频道模板和台标；更新数据并推送后会自动构建新镜像。

- `main` 推送：发布 `latest` 和 `sha-<提交短哈希>` 标签。
- `v*` 标签推送：发布同名版本镜像，例如 `v0.1.0`。
- Pull Request：执行校验和构建，不发布镜像。
- 在仓库 **Actions → Build and publish container → Run workflow** 可手动触发。

工作流使用 GitHub 自动提供的 `GITHUB_TOKEN`，无需手动配置密码或 Token。
首次发布后，如需匿名拉取，在 GitHub 个人主页的 **Packages → china-iptv-udpxy → Package settings → Change visibility** 中将镜像设为 **Public**（包首次发布默认私有）。

代码推送：

```bash
git push -u origin main
```

## 使用前提（重要）

- 组播源设备必须与**光猫在同一网段**（组播不跨路由）
- 光猫电源（Power）和注册（PON）指示灯常亮即可使用组播，**无需拨号**
- 需在路由器/NAS 上部署 [udpxy](https://github.com/pvicente/udpxy)（OpenWrt: `opkg install udpxy`），默认端口 4022

## Browser 专用列表

独立存放在 [`browser/`](browser/README.md)，来源为 `mytv-android/China-TV-Live-M3U8`。部署新版镜像后，Android 自定义直播源可填写：

```text
https://你的域名/api/browser/playlist.m3u
```

此地址直接返回 Browser 列表，不经过 Mix，不需要省份、运营商或 `udpxy` 参数。仅维护 `browser/playlist.m3u` 一份列表：保留全部 WebView 线路，适配 Android 多线路解析，台标全部指向本站内置图片，地址随访问域名和协议自动生成。使用 `bun run fetch:browser` 单独更新。

## Mix 混合订阅

将所选省份/运营商的 IPTV 与 Browser 列表融合成一个订阅：

```text
GET /api/mix/{province}/{operator}/{source}/{type}
```

参数与普通订阅相同，`source` 选择 `mc` 或 `uc`，`type` 选择 `m3u` 或 `txt`。例如浙江电信组播混合订阅：

```text
https://你的域名/api/mix/zhejiang/telecom/mc/m3u?udpxy=192.168.30.100:5140/app/rtp2httpd&fcc=115.233.40.137:8027
```

- 匹配 `tvg-name`，没有该属性时匹配显示名称。Browser 名称差异统一在 `aliases.yml` 的 `browser.aliases` 中配置，生成列表时应用；合并路由不内置别名或猜测频道名。
- 同频道使用省份 IPTV 的显示名称、分组和台标，先排列 IPTV 线路，再追加 Browser 线路，重复 URL 去重。客户端可将它们识别为一个频道的多条线路。
- 保留省份 IPTV 的全部频道，同时追加 Browser 独有频道。同频道不同画质若使用相同名称也会作为多线路保留；不根据 IP 猜测清晰度。
- `udpxy`、`fcc` 只作用于 IPTV 组播地址，Browser 网页地址保留不变。台标依旧跟随访问域名，使用中文文件名。
- 每次请求读取本地列表，不实时抓取上游。任一输入列表缺失或格式错误时返回错误，不静默输出不完整混合源。

当前路由一次选择一个省份及运营商。客户端使用合并后的列表即可获得两类线路；Android 自身的混合模式可设为禁用，避免再追加内置网页线路。具备网页线路并不代表普通视频播放器能够播放它，客户端仍需支持 `webview://`。

## 数据更新

```bash
bun run fetch          # 仅更新直播源（iptv/）
bun run fetch:logo     # 仅同步上游台标（logo/）
bun run fetch:all      # 全部更新
bun run verify         # 健康校验（--strict 供 CI 使用）
```

## aliases.yml 结构

### Docker 外部挂载

Compose 已挂载宿主机的 `aliases/` 和 `iptv/`，可以直接编辑宿主机文件，无需重新构建镜像。使用已发布镜像时，在本仓库根目录执行：

```bash
docker run -d --name china-iptv-udpxy --restart unless-stopped \
  -p 8080:8080 \
  -v "$(pwd)/aliases:/app/aliases:ro" \
  -v "$(pwd)/iptv:/app/iptv:ro" \
  ghcr.io/1021683053/china-iptv-udpxy:latest
```

挂载前请保留本仓库完整的 `aliases/`、`iptv/` 内容，空目录会遮住镜像内置文件。`:ro` 仅限制容器写入，宿主机仍可修改。

- 修改 `aliases/aliases.yml` 后，在宿主机运行 `bun run fetch` 重新生成模板；YAML 仍在生成阶段读取。
- 直接修改 `iptv/` 中已有模板，服务下次请求就会读取新内容，无需重启。新增省份/运营商/数据源组合需要重启以更新启动时的索引。
- `aliases/logo/` 可以直接添加或替换台标；已有引用无需重启，新台标需更新模板中的引用。

播放器或 HTTP 缓存可能延迟显示更新，订阅链接加 `nocache=1` 并刷新订阅可跳过订阅响应缓存；台标缓存最长一小时。

两级配置：

- **`global`**：对所有省份生效的归一规则
- **`provinces.{省份}.{运营商}`**：省级补充，在 global 之后执行——同名键覆盖 global，新增键追加；用于处理某省特有的命名差异、屏蔽或台标

每级均支持四段（处理顺序一致）：

| 段 | 作用 | 示例 |
|---|---|---|
| `rules` | 正则归一，先执行 | `CCTV-1` → `CCTV1` |
| `aliases` | 精确归一 | `哈哈炫幼` → `哈哈炫动` |
| `channels` | 属性覆盖/屏蔽 | `购物: {ignore: true}` |
| `logo_aliases` | 台标兜底映射 | `BESTV1: BesTV-1` |

## 免责声明

全部内容来自互联网公开渠道整理，仅供学习与研究。所列组播地址需在运营商 IPTV 网络内、配合 udpxy 使用，本项目不提供、不托管、不分发任何音视频内容。
