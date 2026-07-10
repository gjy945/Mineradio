# 音源整合设计 — Mineradio + AlgerMusicPlayer

> 日期: 2026-07-10
> 状态: Draft — 待审批

## 目标

将 AlgerMusicPlayer 的多平台音源逻辑（VIP免费听、多源切换）集成到 Mineradio，保留 Mineradio 的所有UI和交互体验。

## 现状对比

### Mineradio (目标)
| 维度 | 现状 |
|------|------|
| 架构 | Electron + 内联HTML (1MB+) + server.js (4200行) + desktop/main.js |
| 音源 | 仅 NeteaseCloudMusicApi，纯网易云 |
| VIP | 无VIP → 试听片段或无法播放 |
| QQ音乐 | 通过 `.qq-cookie` 导入QQ歌单（UI层已有） |
| 前端 | 单文件 index.html，所有JS内联 |
| 后端 | server.js 处理所有 HTTP API + 网易云代理 |

### AlgerMusicPlayer (参考)
| 维度 | 实现 |
|------|------|
| 架构 | Electron-Vite + Vue3 + TS + Pinia |
| 音源 | `@unblockneteasemusic/server` (migu/kugou/kuwo/pyncmd) |
| 额外 | LX Music 落雪脚本引擎 (Worker沙箱) |
| 额外 | GD Music 外部API (joox/tidal/netease) |
| 额外 | 自定义API插件系统 (JSON配置) |
| 额外 | 歌曲级音源配置 (SongSourceConfigManager) |
| 额外 | 缓存管理 (URL缓存 + 失败缓存) |
| 策略 | 策略模式: LxMusic → CustomApi → GDMusic → UnblockMusic |

## 整合范围

### ✅ 集成（高优先级，解决VIP问题）
1. **`@unblockneteasemusic/server`** — 在 server.js 中直接调用 match()，网易云VIP歌曲自动切换到 migu/kugou/kuwo/pyncmd 音源
2. **GD Music** — 作为备选音源（`https://music-api.gdstudio.xyz/api.php`），支持 joox/tidal/netease
3. **音源选择设置** — 前端添加音源配置UI（勾选启用哪些音源）
4. **缓存机制** — 内存级URL缓存 + 失败缓存（避免重复请求坏音源）

### ⏸️ 延后（第二阶段）
- **LX Music 落雪脚本引擎** — 需要 Worker 沙箱环境，Mineradio 的单文件架构改造成本大
- **自定义API插件** — 可在第一阶段以简单配置形式先做

### ❌ 不集成
- AlgerMusicPlayer 的前端 Vue 组件、Pinia store、路由等
- MPRIS 服务、字体列表等桌面级功能

## 技术方案

### Phase 1: 后端集成 (server.js)

在 server.js 中添加 `@unblockneteasemusic/server` 调用：

```javascript
// 新增依赖
const match = require('@unblockneteasemusic/server');

// 新增 API: /api/music/unblock
// 输入: { id, name, artists, album }
// 输出: { url, br, size, platform }
```

**核心逻辑**:
1. 网易云 `song_url` 返回 VIP/试听限制时 → 自动调用 `match()` 解锁
2. 依次尝试所有 enabled platforms (migu → kugou → kuwo → pyncmd)
3. 返回第一个成功的 URL
4. 超时保护: 15s 总超时

### Phase 2: 前端集成 (index.html 内联 JS)

在现有内联 JS 中添加：
1. **音源设置面板** — 在设置页添加"音源设置"tab
2. **音源切换提示** — 播放失败时显示"正在切换音源..."
3. **缓存管理** — localStorage 存储音源偏好

### Phase 3: 缓存优化

1. **URL 缓存** — 成功解析的 URL 缓存 30 分钟
2. **失败缓存** — 失败的音源组合缓存 1 分钟
3. **歌曲级配置** — 每首歌可手动指定首选音源

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `package.json` | 修改 | 添加 `@unblockneteasemusic/server` 依赖 |
| `package-lock.json` | 生成 | npm install 后更新 |
| `server.js` | 修改 | 添加 unblockMusic 和 GD Music 逻辑 (~800行新增) |
| `public/index.html` | 修改 | 添加音源设置UI + 前端解析逻辑 (~400行新增) |
| `desktop/main.js` | 修改 | 传递端口给 server.js (已有) |

## 风险评估

| 风险 | 影响 | 缓解 |
|------|------|------|
| `@unblockneteasemusic` 依赖大 | 打包体积增加 ~50MB | 只用于 VIP 歌曲，不阻塞主流程 |
| 音源接口不稳定 | 偶尔解析失败 | 超时 + 多平台重试 + 降级到试听 |
| 前端改动风险 | 可能破坏现有UI | 内联 JS 追加，不修改现有逻辑 |
| 法律合规 | 音源替换可能涉及版权 | 本地功能，不对外分发 |

## 决策记录

- 选择方案A（最小集成）：只在 server.js 添加 unblockMusic，前端最小改动
- 原因：Mineradio 是单文件架构，改造成本高；unblockMusic 直接解决 VIP 问题
- LX Music 引擎延后：需要 Worker 沙箱，与 Mineradio 架构冲突
