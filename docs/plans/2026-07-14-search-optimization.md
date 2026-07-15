# 搜索功能优化设计 — Mineradio

> 日期: 2026-07-14
> 状态: Draft — 待审批
> 参考: AlgerMusicPlayer (D:\Dev-Projects\personal\project\music\AlgerMusicPlayer)

## 一、目标

仿照 AlgerMusicPlayer 优化 Mineradio 的搜索体验，同时保留 Mineradio 单文件内联架构。本次优化聚焦以下七点：

1. **标签中文化** — All/NE/QQ/Podcast 换成中文，并扩展平台来源
2. **多平台对接扩展** — 新增其他主流音乐平台搜索（酷狗/酷我/咪咕等）
3. **搜索建议（autocomplete）** — 输入时实时联想
4. **热搜榜** — 无关键词时展示热门搜索
5. **搜索历史改进** — 记录搜索类型，支持按类型回放
6. **分页加载 + 搜索类型扩展预留** — 单曲先做分页，预留专辑/歌单/MV/电台搜索
7. **搜索源 + 音源可配置化** — 用户可在视觉控制台增删改搜索源和音源平台，项目实时读取

---

## 二、机制说明（回答疑问）

### 2.1 `/api/audio` 代理 + 无VIP播放原理

#### `/api/audio` 是什么
纯**音频流转发代理**（server.js L4581-L4601）：
```
浏览器请求 /api/audio?url=真实音频URL
  → server.js 用 fetch 请求真实URL
  → 透传 Range 请求头（支持拖动进度条）
  → 流式转发响应体给浏览器
  → 加上 CORS 头解决跨域
```
它**不负责解锁**，只解决跨域 + Range 续传。

#### 无VIP播放的真正原理
关键在音源解析链路 `handleSongUrl`（server.js L3388）：
```
1. 网易云 song_url 接口尝试拿URL
2. 判定为 VIP/试听/版权限制
3. 调用 @unblockneteasemusic 库（L140 resolveUnblockMusic）
4. 该库去【其他平台】(pyncmd/migu/kugou/kuwo) 搜同名歌
5. 其他平台不需VIP → 拿到完整版播放URL
6. 返回URL → /api/audio 代理转发 → 浏览器播放
```
所以"无VIP"功臣是 `@unblockneteasemusic` 多平台匹配，`/api/audio` 只解决跨域。

### 2.2 搜索 API 与音源 API 的关系

**两套独立API，通过歌曲唯一标识串联**：

| 维度 | 搜索 API | 音源 API |
|------|----------|----------|
| 网易 | `/api/search?keywords=xxx` | `/api/song/url?id=12345` |
| QQ | `/api/qq/search?keywords=xxx` | `/api/qq/song/url?mid=abc&mediaMid=def` |
| 输入 | 关键词 | 歌曲唯一标识 |
| 输出 | 歌曲元数据列表 | 播放URL |
| 作用 | 找到歌，拿到ID | 用ID换URL |

#### 搜索结果格式（server.js L1806 `mapSongRecord`）
```javascript
{
  provider: 'netease',    // 来源平台标识
  source: 'netease',
  type: 'song',
  id: 12345,              // ★ 网易云歌曲数字ID（音源API用这个）
  name: '晴天',
  artist: '周杰伦',
  artists: [{id, name}],
  artistId: 123,
  album: '叶惠美',
  cover: 'http://p1.music...jpg',
  duration: 240000,       // 毫秒
  fee: 1,                 // 1=VIP, 0=免费, 4=专辑付费
}
```
QQ 搜索结果格式类似（`mapQQTrack`），但用 `mid`（字符串）+ `mediaMid` 替代 `id`。

#### 音源播放需要的输入格式
- **网易**：只需 `id`（数字）→ `/api/song/url?id=12345`
- **QQ**：需要 `mid` + `mediaMid`（字符串）→ `/api/qq/song/url?mid=xxx&mediaMid=yyy`
- 这些字段搜索结果已包含，前端 `playSearchResult` 直接透传（index.html L18331）

#### 为什么搜出来能播
```
搜索 → 返回 {id: 12345, name: '晴天', ...}
         ↓ 用户点击
playSearchResult → playQueueAt → 请求 /api/song/url?id=12345
         ↓
handleSongUrl → 网易API或@unblockneteasemusic → 返回 {url: 'http://m1...mp3'}
         ↓
前端拿到 url → '/api/audio?url=' + encodeURIComponent(url) → 音频流播放
```

---

## 三、现状分析

### 3.1 当前搜索 UI（index.html L1912-L1917）
```
[All] [NE] [QQ] [Podcast]   ← 英文标签，用户看不懂
```
- `searchMode` 取值: `song` / `netease` / `qq` / `podcast`
- `song` = All（网易+QQ 合并）；`netease` = 仅网易；`qq` = 仅 QQ

### 3.2 当前音源配置（server.js L65-L81，硬编码）
```javascript
const ALL_UNBLOCK_PLATFORMS = ['pyncmd', 'migu', 'kugou', 'kuwo']; // L70 硬编码
function getMusicSourceConfig() { return [...ALL_UNBLOCK_PLATFORMS]; } // L81 不支持运行时切换
```

### 3.3 当前搜索 API（server.js）
| 路由 | 函数 | 说明 |
|------|------|------|
| `/api/search` | `handleSearch(kw, limit)` | 网易云 `cloudsearch`，未传 type，默认单曲 |
| `/api/qq/search` | `handleQQSearch(kw, limit)` | QQ smartbox 搜索 |
| `/api/podcast/search` | 内联 `cloudsearch({type:1009})` | 播客电台搜索 |
| `/api/song/url` | `handleSongUrl(sid, ...)` | 网易云音源（含 unblock 多平台降级） |
| `/api/qq/song/url` | `handleQQSongUrl(mid, mediaMid)` | QQ 音源 |

### 3.4 关键发现
- **`cloudsearch` 已支持 type 参数**：`1=单曲, 10=专辑, 100=歌手, 1000=歌单, 1004=MV, 1009=电台`
- **音源降级链路已完备**：网易song_url → @unblockneteasemusic(pyncmd/migu/kugou/kuwo) → GD Music(joox/tidal)
- **搜索历史仅记字符串**：localStorage 存最多 10 条关键词，无类型信息
- **无分页**：`fetchMusicSearchResults` 一次性返回 18 条

### 3.5 配置文件现状
- **项目无专门配置文件**（只有 package.json）
- 音源平台**硬编码**在 server.js L70
- 搜索源标签**硬编码**在前端 index.html
- 视觉控制台 `#fx-panel`（L1989）有现成的 section + 折叠面板结构可复用

---

## 四、设计方案

### 4.1 配置化方案（新增核心，优先级最高）

#### 4.1.1 配置文件设计
新建配置文件 `config/music-sources.json`（项目根目录 `config/` 下）：
```json
{
  "version": 1,
  "searchSources": [
    {
      "id": "netease",
      "name": "网易云",
      "enabled": true,
      "type": "builtin",
      "apiBase": "/api/search",
      "urlApiBase": "/api/song/url",
      "idField": "id",
      "icon": "netease"
    },
    {
      "id": "qq",
      "name": "QQ音乐",
      "enabled": true,
      "type": "builtin",
      "apiBase": "/api/qq/search",
      "urlApiBase": "/api/qq/song/url",
      "idField": "mid",
      "extraIdField": "mediaMid",
      "icon": "qq"
    },
    {
      "id": "kugou",
      "name": "酷狗音乐",
      "enabled": false,
      "type": "builtin",
      "apiBase": "/api/kugou/search",
      "urlApiBase": "/api/kugou/song/url",
      "idField": "hash",
      "extraIdField": "albumId",
      "icon": "kugou"
    }
  ],
  "audioSources": [
    {
      "id": "pyncmd",
      "name": "PyNCM（网易云CDN）",
      "enabled": true,
      "type": "unblock",
      "priority": 1
    },
    {
      "id": "migu",
      "name": "咪咕音乐",
      "enabled": true,
      "type": "unblock",
      "priority": 2
    },
    {
      "id": "kugou",
      "name": "酷狗音乐",
      "enabled": true,
      "type": "unblock",
      "priority": 3
    },
    {
      "id": "kuwo",
      "name": "酷我音乐",
      "enabled": true,
      "type": "unblock",
      "priority": 4
    },
    {
      "id": "joox",
      "name": "JOOX（GD Music）",
      "enabled": false,
      "type": "gd",
      "priority": 5
    }
  ],
  "defaultSearchMode": "all"
}
```

**字段说明**：
- `searchSources`：搜索源配置，控制搜索标签显示和API路由
- `audioSources`：音源平台配置，控制 `@unblockneteasemusic` 和 GD Music 的启用平台
- `type`：`builtin`=内置搜索、`unblock`=@unblockneteasemusic 平台、`gd`=GD Music 平台
- `enabled`：是否启用，false 则不显示/不使用
- `priority`：音源降级顺序（数字越小越优先）

#### 4.1.2 server.js 改造

```javascript
// ========== 配置文件热加载 ==========
const CONFIG_PATH = path.join(__dirname, 'config', 'music-sources.json');
let musicSourceConfig = null;
let configWatcher = null;

function loadMusicSourceConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    musicSourceConfig = JSON.parse(raw);
    console.log('[Config] music-sources.json loaded,',
      'search:', musicSourceConfig.searchSources.filter(s=>s.enabled).length,
      'audio:', musicSourceConfig.audioSources.filter(s=>s.enabled).length);
  } catch (e) {
    console.warn('[Config] load failed, using defaults:', e.message);
    musicSourceConfig = getDefaultSourceConfig(); // 兜底默认
  }
}

function saveMusicSourceConfig(config) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    musicSourceConfig = config;
    console.log('[Config] music-sources.json saved');
    return true;
  } catch (e) {
    console.error('[Config] save failed:', e.message);
    return false;
  }
}

// 启动时加载
loadMusicSourceConfig();

// 文件监听（热重载，用户在外部编辑文件也能生效）
try {
  configWatcher = fs.watch(CONFIG_PATH, { persistent: false }, () => {
    console.log('[Config] file changed, reloading...');
    loadMusicSourceConfig();
  });
} catch (e) { /* 文件可能还不存在，忽略 */ }

// 改造 getMusicSourceConfig（L81 替换）
function getMusicSourceConfig() {
  if (!musicSourceConfig) loadMusicSourceConfig();
  return (musicSourceConfig.audioSources || [])
    .filter(s => s.enabled && s.type === 'unblock')
    .sort((a, b) => (a.priority || 99) - (b.priority || 99))
    .map(s => s.id);
}

// 新增：获取启用的搜索源
function getEnabledSearchSources() {
  if (!musicSourceConfig) loadMusicSourceConfig();
  return (musicSourceConfig.searchSources || []).filter(s => s.enabled);
}

// 新增 API：读取配置
// GET /api/config/sources → 返回当前配置
// PUT /api/config/sources → 保存配置（控制台提交）
if (pn === '/api/config/sources' && req.method === 'GET') {
  sendJSON(res, musicSourceConfig || getDefaultSourceConfig());
  return;
}
if (pn === '/api/config/sources' && req.method === 'PUT') {
  const body = await readRequestBody(req);
  const ok = saveMusicSourceConfig(body);
  sendJSON(res, { ok, config: musicSourceConfig });
  return;
}
```

#### 4.1.3 前端视觉控制台改造

在 `#fx-panel`（index.html L1989）新增一个折叠面板，放在"主控"section 下方：

```html
<!-- 音源配置（新增） -->
<div class="fx-fold" id="fx-sources-fold">
  <div class="fx-fold-head" onclick="document.getElementById('fx-sources-fold').classList.toggle('open')">
    <span class="fx-fold-title"><strong>搜索与音源</strong><small>搜索源 / 音源平台 / 增删改</small></span>
    <span class="arrow">▶</span>
  </div>
  <div class="fx-fold-body">
    <div class="fx-section-label">搜索源</div>
    <div id="search-sources-list" class="sources-list">
      <!-- 动态渲染：每行 [开关] [名称] [API路径] [删除] -->
    </div>
    <button class="fx-mini-btn" onclick="addSearchSource()">+ 添加搜索源</button>

    <div class="fx-section-label">音源平台（VIP解锁）</div>
    <div id="audio-sources-list" class="sources-list">
      <!-- 动态渲染：每行 [开关] [名称] [优先级] [删除] -->
    </div>
    <button class="fx-mini-btn" onclick="addAudioSource()">+ 添加音源平台</button>

    <div class="fx-section-label">操作</div>
    <button class="fx-mini-btn primary" onclick="saveSourceConfig()">保存配置</button>
    <button class="fx-mini-btn ghost" onclick="resetSourceConfig()">恢复默认</button>
    <div id="source-config-tip" class="source-config-tip"></div>
  </div>
</div>
```

#### 4.1.4 前端配置管理逻辑（内联 JS）
```javascript
var sourceConfig = null;

// 加载配置
async function loadSourceConfig() {
  try {
    sourceConfig = await apiJson('/api/config/sources');
    renderSearchSources();
    renderAudioSources();
  } catch (e) { showToast('加载音源配置失败'); }
}

// 渲染搜索源列表
function renderSearchSources() {
  var list = document.getElementById('search-sources-list');
  list.innerHTML = (sourceConfig.searchSources || []).map(function(s, i) {
    return '<div class="source-row">' +
      '<label class="source-switch"><input type="checkbox" ' + (s.enabled?'checked':'') + ' onchange="toggleSearchSource('+i+', this.checked)"></label>' +
      '<input class="source-name" value="' + escHtml(s.name) + '" onchange="updateSearchSource('+i+',\'name\',this.value)">' +
      '<input class="source-api" value="' + escHtml(s.apiBase) + '" title="搜索API路径" onchange="updateSearchSource('+i+',\'apiBase\',this.value)">' +
      '<button class="fx-mini-btn ghost" onclick="removeSearchSource('+i+')">删</button>' +
    '</div>';
  }).join('');
}

// 渲染音源平台列表
function renderAudioSources() {
  var list = document.getElementById('audio-sources-list');
  list.innerHTML = (sourceConfig.audioSources || []).map(function(s, i) {
    return '<div class="source-row">' +
      '<label class="source-switch"><input type="checkbox" ' + (s.enabled?'checked':'') + ' onchange="toggleAudioSource('+i+', this.checked)"></label>' +
      '<input class="source-name" value="' + escHtml(s.name) + '" onchange="updateAudioSource('+i+',\'name\',this.value)">' +
      '<input class="source-priority" type="number" value="' + (s.priority||99) + '" title="优先级(数字越小越优先)" onchange="updateAudioSource('+i+',\'priority\',Number(this.value))">' +
      '<button class="fx-mini-btn ghost" onclick="removeAudioSource('+i+')">删</button>' +
    '</div>';
  }).join('');
}

// 保存
async function saveSourceConfig() {
  try {
    var data = await apiJson('/api/config/sources', { method: 'PUT', body: JSON.stringify(sourceConfig) });
    if (data.ok) {
      showToast('配置已保存，实时生效');
      // 触发搜索标签重新渲染
      rebuildSearchModeTabs();
    } else { showToast('保存失败'); }
  } catch (e) { showToast('保存失败: ' + e.message); }
}

// 增删改
function addSearchSource() {
  sourceConfig.searchSources.push({ id: 'custom_' + Date.now(), name: '新源', enabled: false, type: 'builtin', apiBase: '/api/search', urlApiBase: '', idField: 'id' });
  renderSearchSources();
}
function removeSearchSource(i) { sourceConfig.searchSources.splice(i, 1); renderSearchSources(); }
function toggleSearchSource(i, on) { sourceConfig.searchSources[i].enabled = on; }
function updateSearchSource(i, k, v) { sourceConfig.searchSources[i][k] = v; }
// 音源同理

// 保存后重建搜索标签
function rebuildSearchModeTabs() {
  var container = document.getElementById('search-mode-tabs');
  var enabled = (sourceConfig.searchSources || []).filter(function(s){ return s.enabled; });
  // 第一位永远是"全部"（合并所有启用源）
  var tabs = [{ id: 'song', name: '全部' }].concat(enabled.map(function(s){ return { id: s.id, name: s.name }; }));
  tabs.push({ id: 'podcast', name: '播客' });
  container.innerHTML = tabs.map(function(t, i) {
    return '<button id="search-mode-' + t.id + '" type="button" onclick="setSearchMode(\'' + t.id + '\')" ' + (i===0?'class="active"':'') + '>' + escHtml(t.name) + '</button>';
  }).join('');
  updateSearchModeTabs();
}
```

#### 4.1.5 配置化的影响范围
- **搜索源配置** → 控制搜索标签显示、`fetchMusicSearchResults` 路由、All模式合并范围
- **音源配置** → 控制 `getMusicSourceConfig()` 返回值 → 影响 `@unblockneteasemusic` 尝试哪些平台
- **热重载**：`fs.watch` 监听文件变化 + 控制台保存触发重载
- **兜底**：文件不存在或解析失败时用代码内置默认值

---

### 4.2 标签中文化 + 平台扩展

#### 4.2.1 标签重命名（依赖配置化）
不再硬编码，改为**从配置动态渲染**：
```
默认配置下显示: [全部] [网易云] [QQ音乐] [播客]
启用酷狗后:    [全部] [网易云] [QQ音乐] [酷狗音乐] [播客]
```
配置中 `enabled: true` 的搜索源才显示标签。"全部"和"播客"固定显示。

#### 4.2.2 新增平台对接（酷狗为例）
**server.js 新增酷狗搜索/音源 API**：
```javascript
// /api/kugou/search?keywords=xxx&limit=12
async function handleKugouSearch(keywords, limit) {
  const u = new URL('http://mobilecdn.kugou.com/api/v3/search/song');
  u.searchParams.set('keyword', keywords);
  u.searchParams.set('page', 1);
  u.searchParams.set('pagesize', limit || 12);
  u.searchParams.set('showtype', '10');
  const resp = await fetch(u.toString(), { headers: { 'User-Agent': UA } });
  const json = await resp.json();
  const items = (json.data && json.data.info) || [];
  return items.map(item => ({
    provider: 'kugou',
    source: 'kugou',
    type: 'song',
    id: item.audio_id,
    hash: item.hash,           // ★ 酷狗歌曲标识
    albumId: item.album_id,    // ★ 酷狗专辑标识
    name: item.songname,
    artist: item.singername,
    album: item.album_name,
    cover: item.albumimg || '',
    duration: (item.duration || 0) * 1000,
    fee: 0,
  }));
}

// /api/kugou/song/url?hash=xxx&albumId=yyy
async function handleKugouSongUrl(hash, albumId) {
  const u = new URL('https://wwwapi.kugou.com/yy/index.php');
  u.searchParams.set('r', 'play/getdata');
  u.searchParams.set('hash', hash);
  if (albumId) u.searchParams.set('album_id', albumId);
  u.searchParams.set('dfid', '0');
  u.searchParams.set('mid', '0');
  u.searchParams.set('platid', '4');
  const resp = await fetch(u.toString(), { headers: { 'User-Agent': UA, 'Referer': 'https://www.kugou.com/' } });
  const json = await resp.json();
  const url = json.data && json.data.play_url;
  return { provider: 'kugou', url: url || '', playable: !!url };
}
```

**路由注册**：
```javascript
if (pn === '/api/kugou/search') { /* ... */ }
if (pn === '/api/kugou/song/url') { /* ... */ }
```

**前端播放适配**（index.html `songProviderKey` 已识别 provider）：
```javascript
// 在 fetchBeatPrefetchAudioUrl / playSearchResult 的取源逻辑中增加
var isKugou = songProviderKey(song) === 'kugou';
var data = isKugou
  ? await apiJson('/api/kugou/song/url?hash=' + encodeURIComponent(song.hash) + '&albumId=' + encodeURIComponent(song.albumId || ''))
  : isQQ ? /* ... */ : /* 网易 ... */;
```

### 4.3 搜索类型扩展预留（专辑/歌单/MV/电台）

#### 4.3.1 类型常量定义（内联 JS）
```javascript
var SEARCH_TYPE = {
  SINGLE: 1, ALBUM: 10, ARTIST: 100, PLAYLIST: 1000, MV: 1004, DJ_RADIO: 1009
};
var searchType = SEARCH_TYPE.SINGLE;
```

#### 4.3.2 UI 布局预留
```
第一行（平台）: [全部] [网易云] [QQ音乐] [酷狗]     ← 从配置动态渲染
第二行（类型）: [单曲] [专辑] [歌单] [MV] [电台]    ← 预留，本次仅单曲可点
```
本次：第二行只显示"单曲"高亮，其他灰色不可点。

#### 4.3.3 后端 API 扩展
```javascript
// /api/search 增加 type 和 offset 参数
if (pn === '/api/search') {
  const kw = url.searchParams.get('keywords') || '';
  const limit = parseInt(url.searchParams.get('limit') || '20');
  const type = parseInt(url.searchParams.get('type') || '1');
  const offset = parseInt(url.searchParams.get('offset') || '0');
  const songs = await handleSearch(kw, limit, type, offset);
  sendJSON(res, { songs });
}

async function handleSearch(keywords, limit, type, offset) {
  type = type || 1;
  const result = await cloudsearch({ keywords, limit, type, offset, cookie: userCookie });
  // type=1 → result.body.result.songs
  // type=10 → result.body.result.albums
  // type=1000 → result.body.result.playlists
  // type=1004 → result.body.result.mvs
  // type=1009 → result.body.result.djRadios
}
```

### 4.4 搜索建议（autocomplete）

#### 4.4.1 交互设计
- 输入框获得焦点 + 有输入时，下拉显示搜索建议
- 300ms 防抖触发请求
- ↑↓ 键导航，Enter 选中，Escape 关闭
- 点击建议项立即搜索

#### 4.4.2 数据源
双源合并（仿 AlgerMusicPlayer）：
- **网易云**：`/api/search/suggest?keywords=xxx`（NeteaseCloudMusicApi 自带 `search_suggest`）
- **酷狗**：`http://mobilecdn.kugou.com/api/v3/search/song?keyword=xxx&pagesize=10`（仅取歌名做建议）

合并去重后取前 8 条。

#### 4.4.3 后端新增 API
```javascript
// /api/search/suggest?keywords=xxx
async function handleSearchSuggest(keywords) {
  const neRes = await search_suggest({ keywords, cookie: userCookie });
  const neSongs = (neRes.body && neRes.body.result && neRes.body.result.songs) || [];
  let kgSongs = [];
  try { kgSongs = await fetchKugouSuggest(keywords); } catch (e) {}
  return mergeSuggestions(neSongs, kgSongs, 8);
}
```

#### 4.4.4 前端实现
```javascript
var suggestRequestSeq = 0, suggestHighlightIndex = -1, suggestTimer = null;
var currentSuggestions = [];

function onSearchInput() {
  var q = $input.value.trim();
  clearTimeout(suggestTimer);
  if (!q) { hideSuggestions(); renderSearchHistory(); return; }
  if (q.length < 2) return; // 最小2字符
  suggestTimer = setTimeout(function() { fetchSuggestions(q); }, 300);
}

async function fetchSuggestions(q) {
  var seq = ++suggestRequestSeq;
  try {
    var data = await apiJson('/api/search/suggest?keywords=' + encodeURIComponent(q));
    if (seq !== suggestRequestSeq) return; // 竞态守卫
    currentSuggestions = (data && data.suggestions) || [];
    suggestHighlightIndex = -1;
    renderSuggestions();
  } catch (e) { hideSuggestions(); }
}
// ↑↓/Enter/Escape 键盘导航 + 渲染下拉
```

### 4.5 热搜榜

#### 4.5.1 交互设计
- 搜索框为空 + 获得焦点时，显示热搜榜 + 搜索历史（上下排列）
- 点击热搜词立即搜索

#### 4.5.2 后端新增 API
```javascript
// /api/search/hot
async function handleSearchHot() {
  const r = await search_hot_detail({ cookie: userCookie, timestamp: Date.now() });
  const list = (r.body && r.body.data) || [];
  return list.map(item => ({
    keyword: item.searchWord,
    score: item.score,
    icon: item.iconUrl || '',
    desc: item.content || ''
  })).slice(0, 20);
}
```

### 4.6 搜索历史改进

#### 4.6.1 数据结构升级
当前：`["周杰伦", "晴天"]`（纯字符串）
改为：`[{ keyword, type, platform }, ...]`，最多 20 条（从 10 扩到 20）

#### 4.6.2 兼容性
读取时若为字符串自动升级为 `{keyword: str, type: 'song', platform: 'all'}`。

### 4.7 分页加载

#### 4.7.1 交互设计
首次加载 30 条，滚动到底部自动加载下一页 30 条，直到无更多。

#### 4.7.2 前端实现
```javascript
var SEARCH_PAGE_SIZE = 30;
var searchCurrentPage = 0, searchHasMore = true, searchIsLoadingMore = false;

async function doSearch(q, opts) {
  // 重置分页状态
  searchCurrentPage = 0; searchHasMore = true;
  var songs = await fetchMusicSearchResultsPage(q, searchMode, 0);
  renderSongSearchResults(songs);
}

async function loadMoreSearchResults() {
  if (searchIsLoadingMore || !searchHasMore) return;
  searchCurrentPage++;
  var more = await fetchMusicSearchResultsPage(searchCurrentQuery, searchCurrentMode, searchCurrentPage);
  if (!more.length) searchHasMore = false;
  else appendSongSearchResults(more);
}
// #search-results 滚动监听 → loadMoreSearchResults()
```

#### 4.7.3 后端支持
`/api/search` 和 `/api/qq/search` 增加 `offset` 参数。

---

## 五、实施计划（分阶段）

### 第一阶段（本次实现）

| # | 任务 | 文件 | 改动量 |
|---|------|------|--------|
| 1 | **配置化：新建 config/music-sources.json** | config/music-sources.json (新) | ~60 行 |
| 2 | **配置化：server.js 热加载 + 读写 API** | server.js | ~120 行 |
| 3 | **配置化：视觉控制台新增"搜索与音源"面板** | index.html | ~200 行 |
| 4 | **配置化：改造 getMusicSourceConfig + 搜索标签动态渲染** | server.js + index.html | ~80 行 |
| 5 | 标签中文化（依赖配置化，自动生效） | index.html | ~10 行 |
| 6 | 搜索建议 autocomplete | index.html + server.js | ~200 行 |
| 7 | 热搜榜 | index.html + server.js | ~120 行 |
| 8 | 搜索历史改进（记录类型，扩到20条） | index.html | ~50 行 |
| 9 | 分页加载（单曲） | index.html + server.js | ~150 行 |
| 10 | 搜索类型预留（UI 第二行，仅单曲可用） | index.html | ~40 行 |

### 第二阶段（后续，平台扩展）
| # | 任务 |
|---|------|
| 11 | 酷狗音乐搜索 + 播放源对接（写入默认配置但 enabled:false） |
| 12 | 评估酷我/咪咕/B站接入 |

### 第三阶段（后续，类型扩展）
| # | 任务 |
|---|------|
| 13 | 专辑搜索 + 详情页跳转 |
| 14 | 歌单搜索 + 加入歌单 |
| 15 | MV 搜索 + 播放 |
| 16 | 电台搜索（合并现有播客） |

---

## 六、文件变更清单（第一阶段）

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `config/music-sources.json` | **新建** | 搜索源 + 音源配置（用户可编辑） |
| `server.js` | 修改 | 配置热加载 + `/api/config/sources` GET/PUT + `getMusicSourceConfig` 改造 + `/api/search/suggest` + `/api/search/hot` + `/api/search` 增加 type/offset (~270 行新增) |
| `public/index.html` | 修改 | 视觉控制台"搜索与音源"面板 + 搜索建议UI + 热搜UI + 历史改进 + 分页 + 类型预留 + 标签动态渲染 (~640 行新增/修改) |

**不改动的文件**：`desktop/main.js`、`package.json`（第一阶段无新依赖）

---

## 七、UI 改动点详图

### 7.1 视觉控制台新增面板
```
#fx-panel
├── 视觉预设
├── 用户存档
├── 自定义颜色
├── 主控
├── 歌词外观
└── 【新增】搜索与音源 ← 新折叠面板
    ├── 搜索源
    │   ├── [✓] 网易云  /api/search         [删]
    │   ├── [✓] QQ音乐  /api/qq/search      [删]
    │   ├── [ ] 酷狗音乐 /api/kugou/search   [删]
    │   └── [+ 添加搜索源]
    ├── 音源平台（VIP解锁）
    │   ├── [✓] PyNCM（网易云CDN）  优先级1  [删]
    │   ├── [✓] 咪咕音乐            优先级2  [删]
    │   ├── [✓] 酷狗音乐            优先级3  [删]
    │   ├── [✓] 酷我音乐            优先级4  [删]
    │   ├── [ ] JOOX（GD Music）    优先级5  [删]
    │   └── [+ 添加音源平台]
    └── [保存配置] [恢复默认]
        提示：保存后实时生效，无需重启
```

### 7.2 搜索区布局变化
```
【当前】
┌─────────────────────────────┐
│ 🔍 [搜索框]                  │
│ [All] [NE] [QQ] [Podcast]   │
└─────────────────────────────┘

【第一阶段后】
┌─────────────────────────────────────┐
│ 🔍 [搜索框]                          │
│ [全部] [网易云] [QQ音乐] [播客]       │  ← 从配置动态渲染
│ [单曲] [专辑] [歌单] [MV] [电台]     │  ← 类型预留(仅单曲可点)
│ ┌─ 热搜榜(空输入时) ──────────────┐ │
│ │ 1.热词  2.热词  3.热词  ...      │ │  ← 新增
│ │ ── 搜索历史 ──                   │ │
│ │ [周杰伦] [晴天] ...              │ │
│ └──────────────────────────────────┘ │
│ ┌─ 搜索建议(输入时) ──────────────┐ │
│ │ 🔍 周杰伦                        │ │  ← 新增
│ │ 🔍 周杰伦 晴天                    │ │
│ └──────────────────────────────────┘ │
│ [搜索结果区 + 滚动分页]               │  ← 分页
└─────────────────────────────────────┘
```

---

## 八、风险与约束

| 风险 | 影响 | 缓解 |
|------|------|------|
| 配置文件误删/格式错误 | 服务启动失败 | `loadMusicSourceConfig` 有 try-catch 兜底默认配置 |
| 用户配置了无效API路径 | 搜索失败 | 前端搜索请求有 try-catch，显示"该源搜索失败" |
| `@unblockneteasemusic` 平台名写错 | 音源解锁失败 | `resolveUnblockMusic` 过滤非法平台名（L147） |
| 酷狗 API 不稳定 | 第三平台搜索偶尔失败 | 失败降级，不阻塞主流程；allSettled 容错 |
| 搜索建议频繁请求 | 后端压力 | 300ms 防抖 + 竞态守卫 + 最小输入长度 2 字符 |
| 分页偏移与排序 | 翻页时结果跳跃 | All 模式按页合并，单平台直接 offset |
| 单文件体积膨胀 | index.html 进一步增大 | 第一阶段预估 +640 行，可接受 |
| 文件监听不触发 | 外部编辑不热重载 | 控制台保存走 API 直接更新内存，不依赖 fs.watch |

---

## 九、决策记录

1. **配置文件用 JSON 而非 JS**：JSON 可被 server.js 和前端共同读写，无需 require，支持热重载
2. **配置文件位置 `config/music-sources.json`**：项目根目录新建 `config/`，与其他配置隔离
3. **音源配置驱动 `getMusicSourceConfig`**：不再硬编码，从配置文件读取 enabled+priority 排序
4. **搜索标签从配置动态渲染**：`rebuildSearchModeTabs` 根据 enabled 源生成按钮
5. **视觉控制台复用 `fx-fold` 折叠结构**：与现有面板风格一致，不破坏布局
6. **酷狗作为第三平台示例**：AlgerMusicPlayer 已验证酷狗接口可用，难度低
7. **类型维度与平台维度正交**：平台筛选（网易云/QQ/酷狗）+ 类型筛选（单曲/专辑/MV）分两行
8. **分页 30 条/页**：对齐 AlgerMusicPlayer
9. **搜索历史扩到 20 条 + 记录类型**：对齐 AlgerMusicPlayer
10. **单文件架构不变**：遵循用户决策（回滚到 6ef657c），所有改动内联
11. **热重载双通道**：`fs.watch` 监听外部编辑 + 控制台 API 保存即时更新内存

---

## 十、验收标准

第一阶段完成后应满足：

### 配置化
- [ ] `config/music-sources.json` 存在，包含默认搜索源和音源配置
- [ ] 视觉控制台出现"搜索与音源"折叠面板
- [ ] 控制台可增删改搜索源和音源平台，点保存后实时生效
- [ ] 外部编辑 JSON 文件，server.js 自动热重载
- [ ] 配置文件误删时，服务用默认配置正常启动

### 搜索体验
- [ ] 四个标签显示中文：全部 / 网易云 / QQ音乐 / 播客
- [ ] 禁用某搜索源后，对应标签消失
- [ ] 输入框输入时 300ms 后出现搜索建议，↑↓ 可导航
- [ ] 输入框空 + 焦点时显示热搜榜 + 搜索历史
- [ ] 搜索历史最多 20 条，记录平台/类型
- [ ] 单曲搜索结果支持滚动分页加载
- [ ] 第二行类型标签显示，单曲高亮可点，其他灰色
- [ ] 搜索到的歌曲点击可正常播放（网易/QQ 均可）
- [ ] 无 console 报错，无回归现有功能
