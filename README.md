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
| `udpxy` | 内网 IPv4:端口 | **组播必填**，udpxy 转发地址 |
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
```

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
