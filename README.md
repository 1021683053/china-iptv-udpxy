# china-iptv-udpxy

基于 [xisohi/CHINA-IPTV](https://github.com/xisohi/CHINA-IPTV) 数据的全国 IPTV 组播 udpxy 代理订阅服务。

## 定位

- **不是**又一个频道数据仓库——数据来自上游，本仓库负责把组播 `rtp://` 地址转成可播放的 udpxy 订阅链接
- 频道名使用上游原名，经 `aliases.yml` 归一（同台不同名 → 统一标准名）
- 台标以通用频道台标库为基础，匹配不到的留空，不伪造

## 目录结构（规划）

```
server/          # 零依赖 Node 订阅服务（多省份路由 + 静态托管）
scripts/         # fetch_all.mjs：拉取上游全部省份，生成 iptv/
iptv/            # 各省模板产物（提交入库，约 1-2MB）
logo/            # 上游台标库（996 个 PNG，跟随上游更新，不被人工修改）
aliases/         # 人工补充区：上游没有的台标 PNG + 归一配置
  ├── *.png      # 补充台标（如 CGTN俄语系全名、地方台）
  └── aliases.yml  # 频道名归一与扩展配置（唯一人工维护点）
```

台标查找顺序：频道名归一 → `aliases/*.png` 补充 → `logo/*.png` 上游 → `logo_aliases` 兜底映射 → 留空。

## aliases.yml 结构

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
