// ====================================================================
//  粒子音乐可视化播放器 — Server v2
//  - 网易云搜索 / 歌曲URL / 封面/音频代理
//  - 扫码登录 (login_qr_*) + cookie 持久化 (./.cookie)
//  - 试听检测 (freeTrialInfo) + 全 quality 探测
//  - 所有受保护 API 都会带上已登录用户的 cookie
// ====================================================================
const {
  search,
  cloudsearch,
  song_detail,
  song_url,
  song_url_v1,
  login_qr_key,
  login_qr_create,
  login_qr_check,
  login_status,
  logout,
  user_account,
  user_playlist,
  comment_music,
  artist_detail,
  artist_top_song,
  artist_songs,
  like: like_song,
  likelist,
  song_like_check,
  playlist_tracks,
  playlist_track_add,
  playlist_create,
  playlist_detail,
  playlist_track_all,
  personalized,
  recommend_resource,
  recommend_songs,
  dj_detail,
  dj_program,
  dj_hot,
  dj_sublist,
  user_audio,
  dj_paygift,
  record_recent_voice,
  sati_resource_sub_list,
  lyric,
  lyric_new,
  toplist,
  top_artists,
  top_song,
  personal_fm,
  search_suggest,
  search_hot_detail,
  hot_search,
} = require('NeteaseCloudMusicApi');
const http = require('http');
const https = require('https');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const { once } = require('events');
const { fileURLToPath } = require('url');
const { analyzePodcastDjStream, analyzePodcastDjIntro } = require('./dj-analyzer');
const AdmZip = require('adm-zip');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ========== 多平台音源解锁 (@unblockneteasemusic) ==========
let matchUnblock = null;
try { matchUnblock = require('@unblockneteasemusic/server').default || require('@unblockneteasemusic/server'); } catch (e) { console.warn('[Unblock] @unblockneteasemusic not available:', e.message); }

// 所有可用音源平台（pyncmd 第一，返回网易云自身 CDN 的有效 URL）
const ALL_UNBLOCK_PLATFORMS = ['pyncmd', 'migu', 'kugou', 'kuwo'];

// 音乐URL缓存 (id -> { url, br, size, platform, expireAt })
const MUSIC_URL_CACHE = new Map();
const MUSIC_URL_CACHE_TTL = 30 * 60 * 1000; // 30分钟

// 失败缓存 (key -> timestamp)
const FAILED_CACHE = new Map();
const FAILED_CACHE_TTL = 60 * 1000; // 1分钟

// 用户启用的音源配置（默认全部启用，不再支持运行时切换）
// 改造：从 config/music-sources.json 读取，支持控制台增删改
const MUSIC_SOURCE_CONFIG_PATH = path.join(__dirname, 'config', 'music-sources.json');
let musicSourceConfig = null;
let musicSourceConfigWatcher = null;

// 兜底默认配置（配置文件丢失/损坏时使用）
// 参照 AlgerMusicPlayer 的音源配置结构
function getDefaultSourceConfig() {
  return {
    version: 3,
    searchSources: [
      { id: 'netease', name: '网易云', enabled: true },
      { id: 'qq', name: 'QQ音乐', enabled: true },
      { id: 'kugou', name: '酷狗音乐', enabled: true },
      { id: 'kuwo', name: '酷我音乐', enabled: true },
      { id: 'migu', name: '咪咕音乐', enabled: true }
    ],
    audioConfig: {
      enableMusicUnblock: true,          // 音源解锁总开关
      enabledMusicSources: ['migu', 'kugou', 'pyncmd'],  // 启用的音源列表
      musicQuality: 'higher',            // 音质: standard/higher/exhigh/lossless/hires
      customApiPlugin: null,             // 自定义API插件 (JSON对象)
      customApiPluginName: '',           // 自定义API名称
      lxMusicScripts: [],                // 洛雪音源脚本列表
      activeLxMusicApiId: null           // 当前激活的洛雪脚本ID
    },
    defaultSearchMode: 'all',
    downloadDir: path.join(__dirname, 'downloads')
  };
}

function loadMusicSourceConfig() {
  try {
    const raw = fs.readFileSync(MUSIC_SOURCE_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    // 基本字段校验：searchSources 数组 + audioConfig 对象
    if (!parsed || !Array.isArray(parsed.searchSources) || !parsed.audioConfig || typeof parsed.audioConfig !== 'object') {
      throw new Error('invalid config structure');
    }
    // 兼容补全
    if (!Array.isArray(parsed.audioConfig.enabledMusicSources)) parsed.audioConfig.enabledMusicSources = [];
    if (!Array.isArray(parsed.audioConfig.lxMusicScripts)) parsed.audioConfig.lxMusicScripts = [];
    if (typeof parsed.downloadDir !== 'string') parsed.downloadDir = path.join(__dirname, 'downloads');
    musicSourceConfig = parsed;
    const enabledSearch = parsed.searchSources.filter(s => s.enabled).length;
    const enabledAudio = parsed.audioConfig.enabledMusicSources.length;
    console.log('[Config] music-sources.json loaded — search:', enabledSearch, 'audio:', enabledAudio);
  } catch (e) {
    console.warn('[Config] load failed, using defaults:', e.message);
    musicSourceConfig = getDefaultSourceConfig();
  }
}

function saveMusicSourceConfig(config) {
  try {
    if (!config || !Array.isArray(config.searchSources) || !config.audioConfig || typeof config.audioConfig !== 'object') {
      return { ok: false, error: 'INVALID_CONFIG' };
    }
    fs.mkdirSync(path.dirname(MUSIC_SOURCE_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(MUSIC_SOURCE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    musicSourceConfig = config;
    console.log('[Config] music-sources.json saved');
    return { ok: true };
  } catch (e) {
    console.error('[Config] save failed:', e.message);
    return { ok: false, error: e.message };
  }
}

function getEnabledSearchSources() {
  if (!musicSourceConfig) loadMusicSourceConfig();
  return (musicSourceConfig.searchSources || []).filter(s => s.enabled);
}

// JSON 路径提取（如 "data.list" → obj.data.list）
function getJsonPath(obj, path) {
  if (!obj || !path) return null;
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return null;
    cur = cur[p];
  }
  return cur;
}

// 启动时加载配置
loadMusicSourceConfig();

// 文件监听（热重载，用户在外部编辑文件也能生效）
try {
  musicSourceConfigWatcher = fs.watch(MUSIC_SOURCE_CONFIG_PATH, { persistent: false }, () => {
    console.log('[Config] file changed, reloading...');
    loadMusicSourceConfig();
  });
} catch (e) { /* 文件可能还不存在，忽略 */ }

// ========== 应用配置文件管理（替代 localStorage 的服务端配置）==========
// 应用配置文件目录
const APP_CONFIG_DIR = path.join(__dirname, 'config');
// 应用配置元数据（前后端共享：每个分类一个 JSON 文件，文件内是 lsKey -> value 映射）
const APP_CONFIG_META = [
  { key: 'visual', file: 'visual.json', label: '视觉布局', desc: '粒子效果、歌词样式、背景颜色、3D相机、壁纸、FX预设', lsKeys: ['mineradio-lyric-layout-v1', 'mineradio-free-camera-v1', 'mineradio-hero-wallpaper-v1', 'mineradio-user-fx-archives-v1'] },
  { key: 'playback', file: 'playback.json', label: '播放设置', desc: '音质、音量、续播会话、睡眠定时器、听歌统计', lsKeys: ['mineradio-playback-quality-v1', 'apex-player-volume', 'mineradio-playback-session-v1', 'mineradio-sleep-timer-v1', 'mineradio-listen-stats-v1'] },
  { key: 'lyrics', file: 'lyrics.json', label: '歌词与封面', desc: '自定义歌词、歌词偏好、自定义封面映射', lsKeys: ['mineradio-custom-lyrics-v1', 'mineradio-custom-lyric-prefs-v1', 'mineradio-custom-covers'] },
  { key: 'search', file: 'search.json', label: '搜索', desc: '搜索历史记录', lsKeys: ['mineradio-search-history'] },
  { key: 'hotkeys', file: 'hotkeys.json', label: '快捷键', desc: '键盘快捷键设置', lsKeys: ['mineradio-hotkey-settings-v1'] },
  { key: 'beatmaps', file: 'beatmaps.json', label: '节拍', desc: '本地节拍数据与偏好', lsKeys: ['mineradio-local-beatmaps-v1', 'mineradio-local-beatmap-prefs-v1'] },
  { key: 'ui', file: 'ui.json', label: '界面偏好', desc: 'DIY模式、面板钉住、自动隐藏、天气城市、引导提示等', lsKeys: ['mineradio-diy-player-mode-v1', 'mineradio-playlist-panel-pinned-v1', 'mineradio-user-capsule-auto-hide-v1', 'mineradio-fx-fab-auto-hide-v1', 'mineradio-controls-auto-hide-v1', 'mineradio-visual-guide-seen-v2', 'mineradio-upload-tip-seen', 'mineradio-weather-city'] },
];
// 构建 lsKey -> configKey 的反向映射
const LS_KEY_TO_CONFIG = {};
APP_CONFIG_META.forEach(function(meta) {
  meta.lsKeys.forEach(function(lsKey) {
    LS_KEY_TO_CONFIG[lsKey] = meta.key;
  });
});

// 读取单个配置分类文件（文件不存在或解析失败返回 null）
function readAppConfigFile(configKey) {
  var meta = APP_CONFIG_META.find(function(m) { return m.key === configKey; });
  if (!meta) return null;
  var filePath = path.join(APP_CONFIG_DIR, meta.file);
  try {
    var raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// 写入单个配置分类文件
function writeAppConfigFile(configKey, data) {
  var meta = APP_CONFIG_META.find(function(m) { return m.key === configKey; });
  if (!meta) return false;
  try {
    fs.mkdirSync(APP_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(APP_CONFIG_DIR, meta.file), JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[AppConfig] write failed:', configKey, e.message);
    return false;
  }
}

// 读取所有配置（返回 { configKey: { lsKey: value, ... }, ... }）
function readAllAppConfigs() {
  var result = {};
  APP_CONFIG_META.forEach(function(meta) {
    var data = readAppConfigFile(meta.key);
    result[meta.key] = data || {};
  });
  return result;
}

// 根据 lsKey 写入配置（前端 PUT /api/app-config/item 时调用）
function setAppConfigItem(lsKey, value) {
  var configKey = LS_KEY_TO_CONFIG[lsKey];
  if (!configKey) return false;
  var meta = APP_CONFIG_META.find(function(m) { return m.key === configKey; });
  if (!meta) return false;
  // 读取当前文件内容
  var data = readAppConfigFile(configKey) || {};
  // 写入/更新该 lsKey
  data[lsKey] = value;
  return writeAppConfigFile(configKey, data);
}

// 读取原始请求体为 Buffer（用于二进制数据，如 zip 上传）
function readRequestBodyAsBuffer(req) {
  return new Promise(resolve => {
    var chunks = [];
    var total = 0;
    req.on('data', function(chunk) {
      chunks.push(chunk);
      total += chunk.length;
      if (total > 16 * 1024 * 1024) req.destroy();
    });
    req.on('end', function() {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', function() { resolve(Buffer.alloc(0)); });
  });
}

// 从配置读取启用的 unblock 平台（参照 AlgerMusicPlayer 的 enabledMusicSources）
function getMusicSourceConfig() {
  if (!musicSourceConfig) loadMusicSourceConfig();
  const ac = musicSourceConfig.audioConfig;
  if (!ac || !ac.enableMusicUnblock) return [];
  const enabled = Array.isArray(ac.enabledMusicSources) ? ac.enabledMusicSources : [];
  // 只返回 unblock 类型的平台（过滤掉 gdmusic/lxMusic/custom）
  const list = enabled.filter(p => ALL_UNBLOCK_PLATFORMS.includes(p));
  return list.length ? list : [...ALL_UNBLOCK_PLATFORMS];
}

// 获取完整音源配置
function getAudioConfig() {
  if (!musicSourceConfig) loadMusicSourceConfig();
  return musicSourceConfig.audioConfig || getDefaultSourceConfig().audioConfig;
}

/**
 * 检查是否在失败缓存期内
 */
function isInFailedCache(key) {
  const cachedTime = FAILED_CACHE.get(key);
  if (cachedTime && Date.now() - cachedTime < FAILED_CACHE_TTL) return true;
  if (cachedTime) FAILED_CACHE.delete(key);
  return false;
}

/**
 * 添加失败缓存
 */
function addFailedCache(key) {
  FAILED_CACHE.set(key, Date.now());
}

/**
 * 获取缓存的音乐URL
 */
function getCachedMusicUrl(id) {
  try {
    const cached = MUSIC_URL_CACHE.get(String(id));
    if (cached && cached.expireAt > Date.now()) return cached;
    if (cached) MUSIC_URL_CACHE.delete(String(id));
  } catch (e) {}
  return null;
}

/**
 * 缓存音乐URL
 */
function setCachedMusicUrl(id, result) {
  try {
    MUSIC_URL_CACHE.set(String(id), { ...result, expireAt: Date.now() + MUSIC_URL_CACHE_TTL });
  } catch (e) {}
}

/**
 * 统一歌曲数据格式 (网易云 -> unblock)
 */
function normalizeSongForUnblock(songData) {
  if (!songData) return { name: '', artists: [], album: { name: '' } };
  const name = songData.name || '';
  const artists = (songData.artists || songData.ar || [])
    .filter(a => a)
    .map(a => ({ name: (a.name || '').toString() }));
  const album = (songData.album || songData.al || {}) || { name: '' };
  if (album.name === undefined) album.name = '';
  return { name, artists, album };
}

/**
 * 通过 @unblockneteasemusic 解析歌曲URL
 * 依次尝试所有 enabled platforms
 * songDetail 必须传完整歌曲信息（从已登录的 API 获取），否则用已登录 cookie 自行获取
 */
async function resolveUnblockMusic(id, songDetail, enabledPlatforms) {
  if (!matchUnblock) return null;
  
  const key = `${id}_${enabledPlatforms.join(',')}`;
  if (isInFailedCache(key)) return null;

  const filteredPlatforms = (enabledPlatforms || ALL_UNBLOCK_PLATFORMS)
    .filter(p => ALL_UNBLOCK_PLATFORMS.includes(p));
  
  if (!filteredPlatforms.length) return null;

  // 优先用传入的 songDetail，没有则用已登录的 API 获取
  let processedSong = songDetail;
  if (!processedSong || !processedSong.name) {
    try {
      const detailResult = await song_detail({ ids: [parseInt(String(id), 10)].join(','), cookie: userCookie });
      const s = detailResult.body && detailResult.body.songs && detailResult.body.songs[0];
      if (s) {
        processedSong = {
          id: s.id,
          name: s.name || '',
          alias: s.alias || [],
          duration: s.dt || s.duration || 0,
          artists: (s.artists || s.ar || []).map(a => ({
            id: a.id,
            name: a.name || ''
          })),
          album: {
            id: (s.album || s.al || {}).id,
            name: (s.album || s.al || {}).name || ''
          }
        };
      }
    } catch (e) {
      console.log(`[Unblock] song_detail failed for id=${id}:`, e.message);
      return null;
    }
  }
  if (!processedSong || !processedSong.name) return null;

  const startTime = Date.now();
  const TIMEOUT = 25000;

  for (const platform of filteredPlatforms) {
    if (Date.now() - startTime > TIMEOUT) break;
    
    try {
      const result = await matchUnblock(
        parseInt(String(id), 10),
        [platform],
        processedSong
      );
      
      if (result && result.url) {
        console.log(`[Unblock] ✅ ${platform} resolved id=${id} (${Date.now() - startTime}ms)`);
        setCachedMusicUrl(id, { ...result, platform });
        return {
          url: result.url,
          trial: false,
          playable: true,
          level: 'higher',
          quality: platform,
          br: result.br || 320000,
          platform,
        };
      }
    } catch (err) {
      console.log(`[Unblock] ${platform} failed for id=${id}:`, err ? (err.message || String(err)) : 'unknown error');
    }
  }

  console.log(`[Unblock] ❌ All platforms failed for id=${id} (${Date.now() - startTime}ms)`);
  addFailedCache(key);
  return null;
}

/**
 * GD Music 外部API解析 (Joox/Tidal)
 */
async function resolveGDMusic(id, songData) {
  const key = `gd_${id}`;
  if (isInFailedCache(key)) return null;

  if (!songData || !songData.name) return null;

  const songName = songData.name;
  let artistList = [];
  if (songData.artists && Array.isArray(songData.artists)) {
    artistList = songData.artists.map(a => a?.name).filter(Boolean);
  } else if (songData.ar && Array.isArray(songData.ar)) {
    artistList = songData.ar.map(a => a?.name).filter(Boolean);
  }
  const artistNames = artistList.join(' ');
  const searchQuery = `${songName} ${artistNames}`.trim();

  if (!searchQuery || searchQuery.length < 2) return null;

  const sources = ['joox', 'tidal'];
  const baseUrl = 'https://music-api.gdstudio.xyz/api.php';

  for (const source of sources) {
    try {
      // Step 1: Search
      const searchUrl = `${baseUrl}?types=search&source=${source}&name=${encodeURIComponent(searchQuery)}&count=5&pages=1`;
      const searchResp = await fetch(searchUrl, { signal: AbortSignal.timeout(5000) });
      if (!searchResp.ok) continue;
      const searchResults = await searchResp.json();

      if (!Array.isArray(searchResults) || !searchResults.length) continue;

      // Pick best candidate by name matching
      let bestItem = null;
      for (const item of searchResults) {
        if (!item || !item.id) continue;
        const itemName = (item.name || '').toLowerCase().replace(/[（(【[].*?[)）】\]]/g, '').trim();
        const expectedName = songName.toLowerCase().replace(/[（(【[].*?[)）】\]]/g, '').trim();
        if (itemName === expectedName || itemName.includes(expectedName) || expectedName.includes(itemName)) {
          bestItem = item;
          break;
        }
      }
      if (!bestItem) continue;

      // Step 2: Get URL
      const trackId = bestItem.id;
      const trackSource = bestItem.source || source;
      const songUrl = `${baseUrl}?types=url&source=${trackSource}&id=${trackId}&br=999`;
      const songResp = await fetch(songUrl, { signal: AbortSignal.timeout(5000) });
      if (!songResp.ok) continue;
      const songDataResult = await songResp.json();

      if (songDataResult && songDataResult.url) {
        console.log(`[GD Music] ✅ ${trackSource} resolved id=${id}`);
        return {
          url: songDataResult.url.replace(/\\/g, ''),
          trial: false,
          playable: true,
          level: 'exhigh',
          quality: 'gdmusic',
          br: parseInt(songDataResult.br, 10) * 1000 || 320000,
          platform: 'gdmusic',
        };
      }
    } catch (err) {
      console.log(`[GD Music] ${source} failed for id=${id}:`, err.message);
    }
  }

  addFailedCache(key);
  return null;
}

// ---------- 自定义API音源解析（参照 AlgerMusicPlayer CustomApiStrategy）----------
// CustomApiPlugin schema: { name, apiUrl, method?, params, qualityMapping?, responseUrlPath }
async function resolveCustomAudioSource(id, songData) {
  const ac = getAudioConfig();
  if (!ac.customApiPlugin || !ac.enabledMusicSources || !ac.enabledMusicSources.includes('custom')) return null;
  const plugin = ac.customApiPlugin;
  if (!plugin.apiUrl || !plugin.params) return null;

  const key = `custom_${id}`;
  if (isInFailedCache(key)) return null;

  // 从 songData 提取歌曲信息
  const name = songData && songData.name || '';
  let artist = '';
  if (songData && songData.artists && Array.isArray(songData.artists)) {
    artist = songData.artists.map(a => a && a.name || '').filter(Boolean).join(' ');
  } else if (songData && songData.ar && Array.isArray(songData.ar)) {
    artist = songData.ar.map(a => a && a.name || '').filter(Boolean).join(' ');
  }
  const album = (songData && songData.album && songData.album.name) || (songData && songData.al && songData.al.name) || '';

  try {
    // 填充参数模板（支持 {songId} {songName} {artist} {album} {quality}）
    const quality = ac.musicQuality || 'higher';
    const qualityMapped = (plugin.qualityMapping && plugin.qualityMapping[quality]) || quality;
    const params = {};
    for (const [k, v] of Object.entries(plugin.params)) {
      params[k] = String(v)
        .replace('{songId}', id)
        .replace('{songName}', name)
        .replace('{artist}', artist)
        .replace('{album}', album)
        .replace('{quality}', qualityMapped);
    }

    const method = (plugin.method || 'GET').toUpperCase();
    const headers = plugin.headers || { 'Content-Type': 'application/json' };
    let apiUrl = plugin.apiUrl;
    const opts = { method, headers, signal: AbortSignal.timeout(10000) };

    if (method === 'GET') {
      const qs = new URLSearchParams(params).toString();
      apiUrl = apiUrl + (apiUrl.includes('?') ? '&' : '?') + qs;
    } else {
      opts.body = JSON.stringify(params);
    }

    const resp = await fetch(apiUrl, opts);
    if (!resp.ok) { addFailedCache(key); return null; }
    const data = await resp.json();
    // 用 responseUrlPath 提取URL（支持点号路径如 "data.url"）
    const audioUrl = getJsonPath(data, plugin.responseUrlPath || 'url') || '';
    if (audioUrl) {
      return {
        url: audioUrl,
        trial: false,
        playable: true,
        level: 'exhigh',
        quality: 'custom',
        br: 320000,
        platform: 'custom',
      };
    }
    addFailedCache(key);
  } catch (err) {
    console.log(`[CustomApi] failed for id=${id}:`, err.message);
    addFailedCache(key);
  }
  return null;
}

// ---------- LX Music 音源解析（参照 AlgerMusicPlayer LxMusicStrategy）----------
// 使用 Node.js vm 模块在沙箱中执行洛雪音源脚本
const vm = require('vm');
async function resolveLxMusic(id, songData) {
  const ac = getAudioConfig();
  if (!ac.lxMusicScripts || !ac.lxMusicScripts.length) return null;
  if (!ac.enabledMusicSources || !ac.enabledMusicSources.includes('lxMusic')) return null;
  if (!ac.activeLxMusicApiId) return null;

  // 找到当前激活的脚本
  const script = ac.lxMusicScripts.find(s => s.id === ac.activeLxMusicApiId && s.enabled);
  if (!script || !script.script) return null;

  const key = `lxmusic_${id}`;
  if (isInFailedCache(key)) return null;

  // 从 songData 提取歌曲信息
  const name = songData && songData.name || '';
  let artist = '';
  if (songData && songData.artists && Array.isArray(songData.artists)) {
    artist = songData.artists.map(a => a && a.name || '').filter(Boolean).join(' ');
  } else if (songData && songData.ar && Array.isArray(songData.ar)) {
    artist = songData.ar.map(a => a && a.name || '').filter(Boolean).join(' ');
  }

  // 洛雪音源子源优先级: wy → kw → mg → kg → tx
  const lxSources = ['wy', 'kw', 'mg', 'kg', 'tx'];
  // 音质映射
  const qualityMap = { standard: '128k', higher: '320k', exhigh: '320k', lossless: 'flac', hires: 'flac24bit' };
  const lxQuality = qualityMap[ac.musicQuality] || '320k';

  for (const source of lxSources) {
    if (script.sources && !script.sources.includes(source)) continue;
    try {
      const result = await runLxScript(script.script, source, { id, name, artist }, lxQuality);
      if (result && result.url) {
        return {
          url: result.url,
          trial: false,
          playable: true,
          level: 'exhigh',
          quality: 'lxmusic',
          br: 320000,
          platform: 'lxMusic',
        };
      }
    } catch (err) {
      console.log(`[LxMusic] ${source} failed for id=${id}:`, err.message);
    }
  }
  addFailedCache(key);
  return null;
}

// 在 vm 沙箱中执行洛雪音源脚本
function runLxScript(scriptText, source, songInfo, quality) {
  return new Promise((resolve) => {
    let resolved = false;
    const timeout = setTimeout(() => { if (!resolved) { resolved = true; resolve(null); } }, 8000);

    try {
      const sandbox = {
        globalThis: {},
        setTimeout, clearTimeout, console: { log: () => {}, error: () => {}, warn: () => {} },
        fetch: (url, opts) => fetch(url, opts),  // 暴露fetch供脚本使用
        URLSearchParams, URL, JSON, Object, Array, String, Number, Math, Date, RegExp, Promise,
      };
      // 模拟 lx 全局对象（洛雪音源脚本标准接口）
      sandbox.lx = {
        on: (event, handler) => {
          if (event === 'request') {
            // 脚本注册了请求处理器，模拟一次请求
            try {
              const reqParams = {
                source,
                info: { songmid: songInfo.id, songId: songInfo.id, name: songInfo.name, singer: songInfo.artist },
                quality,
              };
              Promise.resolve(handler(reqParams)).then(result => {
                if (!resolved) { resolved = true; clearTimeout(timeout); resolve(result); }
              }).catch(() => {
                if (!resolved) { resolved = true; clearTimeout(timeout); resolve(null); }
              });
            } catch (e) {
              if (!resolved) { resolved = true; clearTimeout(timeout); resolve(null); }
            }
          }
        },
        send: (event, data) => { /* 同步发送事件 */ },
        EVENT_NAMES: { request: 'request', inited: 'inited' },
        currentScriptInfo: { name: 'lx-script', description: '', version: '1.0.0' },
      };
      sandbox.globalThis.lx = sandbox.lx;

      const context = vm.createContext(sandbox);
      vm.runInContext(scriptText, context, { timeout: 5000 });
    } catch (err) {
      if (!resolved) { resolved = true; clearTimeout(timeout); resolve(null); }
    }
  });
}

// ========== 多平台音源解锁结束 ==========

const COOKIE_FILE = process.env.COOKIE_FILE || path.join(__dirname, '.cookie');
const QQ_COOKIE_FILE = process.env.QQ_COOKIE_FILE || path.join(__dirname, '.qq-cookie');
const UPDATE_WORK_DIR = process.env.MINERADIO_UPDATE_DIR || path.join(__dirname, 'updates');
const UPDATE_DOWNLOAD_DIR = process.env.MINERADIO_UPDATE_DOWNLOAD_DIR || path.join(UPDATE_WORK_DIR, 'downloads');
const UPDATE_PATCH_BACKUP_DIR = process.env.MINERADIO_PATCH_BACKUP_DIR || path.join(UPDATE_WORK_DIR, 'backups', 'patches');
const BEATMAP_CACHE_DIR = process.env.MINERADIO_BEAT_CACHE_DIR || 'D:\\MineradioCache\\beatmaps';
const APP_PACKAGE = readPackageInfo();
const APP_VERSION = process.env.MINERADIO_VERSION || APP_PACKAGE.version || '0.9.11';
const UPDATE_CONFIG = readUpdateConfig(APP_PACKAGE);
const PATCH_MAX_BYTES = 12 * 1024 * 1024;
const PATCH_ALLOWED_ROOTS = new Set(['public', 'desktop', 'build']);
const PATCH_ALLOWED_FILES = new Set(['server.js', 'dj-analyzer.js', 'package.json', 'package-lock.json']);
const UPDATE_FALLBACK_NOTES = [
  '电影镜头节奏更松',
  '音源失败自动换源',
  '右上角更新提示',
];
const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_IP_LOCATION_URL = 'http://ip-api.com/json/';
const WEATHER_DEFAULT_LOCATION = {
  name: '上海',
  country: 'China',
  latitude: 31.2304,
  longitude: 121.4737,
  timezone: 'Asia/Shanghai',
};

const updateDownloadJobs = new Map();

function applySystemCertificateAuthorities() {
  try {
    if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return;
    const bundled = tls.getCACertificates('default') || [];
    const system = tls.getCACertificates('system') || [];
    if (!system.length) return;
    const seen = new Set();
    const merged = [];
    bundled.concat(system).forEach(cert => {
      if (!cert || seen.has(cert)) return;
      seen.add(cert);
      merged.push(cert);
    });
    if (merged.length > bundled.length) tls.setDefaultCACertificates(merged);
  } catch (e) {
    console.warn('[TLS] system CA merge skipped:', e.message);
  }
}

applySystemCertificateAuthorities();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

// ---------- Cookie 持久化 ----------
const COOKIE_ATTRIBUTE_NAMES = new Set(['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly']);
function collectCookiePair(picked, key, value) {
  key = String(key || '').trim();
  if (!key || COOKIE_ATTRIBUTE_NAMES.has(key.toLowerCase())) return;
  if (value === null || value === undefined) return;
  picked.set(key, String(value).trim());
}
function collectCookieInput(input, picked) {
  if (input === null || input === undefined) return;
  if (Array.isArray(input)) {
    input.forEach(item => collectCookieInput(item, picked));
    return;
  }
  if (typeof input === 'object') {
    if (input.name && Object.prototype.hasOwnProperty.call(input, 'value')) {
      collectCookiePair(picked, input.name, input.value);
      return;
    }
    Object.keys(input).forEach(key => {
      const value = input[key];
      if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) {
        collectCookiePair(picked, key, value.value);
      } else if (typeof value !== 'object') {
        collectCookiePair(picked, key, value);
      }
    });
    return;
  }
  String(input).split(/\r?\n/).forEach(line => {
    line.split(';').forEach(part => {
      const raw = String(part || '').trim();
      const idx = raw.indexOf('=');
      if (idx <= 0) return;
      collectCookiePair(picked, raw.slice(0, idx), raw.slice(idx + 1));
    });
  });
}
function normalizeCookieHeader(input) {
  const picked = new Map();
  collectCookieInput(input, picked);
  return Array.from(picked.entries())
    .filter(([key, value]) => key && value != null && String(value) !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}
function rawCookieFallback(input) {
  if (typeof input === 'string') return input.trim();
  if (Array.isArray(input) && input.every(item => typeof item === 'string')) return input.join('; ').trim();
  return '';
}
let userCookie = '';
try { if (fs.existsSync(COOKIE_FILE)) userCookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim(); }
catch (e) { userCookie = ''; }
function saveCookie(c) {
  userCookie = normalizeCookieHeader(c) || rawCookieFallback(c);
  try { fs.writeFileSync(COOKIE_FILE, userCookie); } catch (e) {}
}

let qqCookie = '';
try { if (fs.existsSync(QQ_COOKIE_FILE)) qqCookie = fs.readFileSync(QQ_COOKIE_FILE, 'utf8').trim(); }
catch (e) { qqCookie = ''; }
function saveQQCookie(c) {
  qqCookie = normalizeCookieHeader(c) || rawCookieFallback(c);
  try { fs.writeFileSync(QQ_COOKIE_FILE, qqCookie); } catch (e) {}
}

// ---------- 工具 ----------
function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}
function sendJSON(res, data, status) {
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(JSON.stringify(data));
}
function readPackageInfo() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}
function parseGitHubRepository(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const direct = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (direct) return { owner: direct[1], repo: direct[2].replace(/\.git$/i, '') };
  const github = raw.match(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[#/?].*)?$/i);
  if (github) return { owner: github[1], repo: github[2].replace(/\.git$/i, '') };
  return null;
}
function readUpdateConfig(pkg) {
  const local = (pkg && pkg.mineradio && pkg.mineradio.update) || {};
  const repoHint = process.env.MINERADIO_UPDATE_REPOSITORY
    || process.env.GITHUB_REPOSITORY
    || local.repository
    || local.github
    || (pkg && pkg.repository && (pkg.repository.url || pkg.repository))
    || '';
  const parsed = parseGitHubRepository(repoHint) || {};
  const owner = process.env.MINERADIO_UPDATE_OWNER || local.owner || parsed.owner || '';
  const repo = process.env.MINERADIO_UPDATE_REPO || local.repo || parsed.repo || '';
  return {
    provider: local.provider || 'github',
    owner,
    repo,
    configured: !!(owner && repo),
    preview: local.preview !== false,
    preferMirrors: local.preferMirrors !== false,
    mirrors: readUpdateMirrors(local),
    manifest: process.env.MINERADIO_UPDATE_MANIFEST
      || process.env.MINERADIO_UPDATE_MANIFEST_URL
      || process.env.MINERADIO_UPDATE_MANIFEST_FILE
      || '',
  };
}
function parseUpdateMirrorList(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(/[\n,;]/);
}
function readUpdateMirrors(local) {
  const envMirrors = process.env.MINERADIO_UPDATE_MIRRORS || process.env.MINERADIO_UPDATE_MIRROR || '';
  const raw = envMirrors
    ? parseUpdateMirrorList(envMirrors)
    : parseUpdateMirrorList(local.mirrors || local.downloadMirrors || []);
  const seen = new Set();
  const mirrors = [];
  raw.forEach(item => {
    const url = String(item || '').trim();
    if (!/^https?:\/\//i.test(url)) return;
    const key = url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    mirrors.push(url);
  });
  return mirrors.slice(0, 6);
}
function normalizeDigest(value, algorithm) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const prefix = new RegExp('^' + algorithm + ':', 'i');
  return raw.replace(prefix, '').trim().replace(/^['"]|['"]$/g, '');
}
function assetDigestInfo(asset) {
  const digest = String(asset && asset.digest || '').trim();
  return {
    sha256: normalizeDigest((asset && asset.sha256) || (/^sha256:/i.test(digest) ? digest : ''), 'sha256').toLowerCase(),
    sha512: normalizeDigest((asset && asset.sha512) || (/^sha512:/i.test(digest) ? digest : ''), 'sha512'),
  };
}
function buildMirrorUrl(originalUrl, mirror) {
  const source = String(originalUrl || '').trim();
  const base = String(mirror || '').trim();
  if (!/^https?:\/\//i.test(source) || !/^https?:\/\//i.test(base)) return '';
  if (base.includes('{encodedUrl}')) return base.replace(/\{encodedUrl\}/g, encodeURIComponent(source));
  if (base.includes('{url}')) return base.replace(/\{url\}/g, source);
  return base.replace(/\/+$/, '/') + source;
}
function uniqueDownloadCandidates(urls, opts) {
  opts = opts || {};
  const directUrls = (Array.isArray(urls) ? urls : [urls])
    .map(url => String(url || '').trim())
    .filter(url => /^https?:\/\//i.test(url));
  const directSet = new Set(directUrls.map(url => url.toLowerCase()));
  const mirrors = opts.useMirrors === false ? [] : (UPDATE_CONFIG.mirrors || []);
  const mirrored = [];
  directUrls.forEach(source => {
    mirrors.forEach((mirror, index) => {
      const url = buildMirrorUrl(source, mirror);
      if (url) mirrored.push({
        url,
        label: '国内加速线路 ' + (index + 1),
        mirrored: true,
      });
    });
  });
  const direct = directUrls.map(url => ({
    url,
    label: directSet.has(url.toLowerCase()) ? 'GitHub 直连' : '下载线路',
    mirrored: false,
  }));
  const ordered = UPDATE_CONFIG.preferMirrors === false ? direct.concat(mirrored) : mirrored.concat(direct);
  const seen = new Set();
  return ordered.filter(item => {
    const key = item.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function publicDownloadUrls(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .map(item => item && item.url)
    .filter(Boolean);
}
function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '').replace(/[+].*$/, '').replace(/-.+$/, '');
}
function compareVersions(a, b) {
  const aa = normalizeVersion(a).split('.').map(n => parseInt(n, 10) || 0);
  const bb = normalizeVersion(b).split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(aa.length, bb.length, 3);
  for (let i = 0; i < len; i++) {
    const left = aa[i] || 0;
    const right = bb[i] || 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}
function cleanReleaseLine(line) {
  return String(line || '')
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/^\s*[-*]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}
function extractReleaseNotes(body) {
  const notes = [];
  String(body || '').split(/\r?\n/).forEach(line => {
    const text = cleanReleaseLine(line);
    if (!text) return;
    if (/^(what'?s changed|changes|changelog|full changelog|更新日志)$/i.test(text)) return;
    if (/^https?:\/\//i.test(text)) return;
    if (text.length > 72) return;
    notes.push(text);
  });
  return notes.slice(0, 4);
}
function pickReleaseAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const preferred = list.find(a => /\.(exe|msi)$/i.test(a && a.name || ''))
    || list.find(a => /\.(zip|7z)$/i.test(a && a.name || ''))
    || list[0];
  if (!preferred) return null;
  const digest = assetDigestInfo(preferred);
  const candidates = uniqueDownloadCandidates(preferred.browser_download_url || '');
  return {
    name: preferred.name || '',
    size: preferred.size || 0,
    contentType: preferred.content_type || '',
    downloadUrl: preferred.browser_download_url || '',
    downloadUrls: publicDownloadUrls(candidates),
    sha256: digest.sha256 || '',
    sha512: digest.sha512 || '',
  };
}
function patchAssetVersions(name) {
  const matches = String(name || '').match(/\d+(?:[._-]\d+){1,3}/g) || [];
  return matches.map(item => normalizeVersion(item.replace(/[._-]/g, '.'))).filter(Boolean);
}
function pickPatchAsset(assets, currentVersion, latestVersion) {
  const list = Array.isArray(assets) ? assets : [];
  const current = normalizeVersion(currentVersion || APP_VERSION);
  const latest = normalizeVersion(latestVersion || '');
  const preferred = list.find(a => {
    const name = String(a && a.name || '');
    if (!/\.(patch\.json|patch|json)$/i.test(name)) return false;
    const versions = patchAssetVersions(name);
    if (latest) return versions[0] === current && versions[versions.length - 1] === latest;
    return versions[0] === current && name.toLowerCase().includes('patch');
  }) || list.find(a => {
    const name = String(a && a.name || '');
    if (!/\.(patch\.json|patch|json)$/i.test(name)) return false;
    const versions = patchAssetVersions(name);
    return versions[0] === current && name.toLowerCase().includes('patch');
  }) || list.find(a => /\.(patch\.json|patch)$/i.test(a && a.name || ''));
  if (!preferred) return null;
  const digest = assetDigestInfo(preferred);
  const candidates = uniqueDownloadCandidates(preferred.browser_download_url || '');
  return {
    name: preferred.name || '',
    size: preferred.size || 0,
    contentType: preferred.content_type || '',
    downloadUrl: preferred.browser_download_url || '',
    downloadUrls: publicDownloadUrls(candidates),
    sha256: digest.sha256 || '',
    sha512: digest.sha512 || '',
  };
}
function updateAssetNameFromUrl(value) {
  try {
    const u = new URL(String(value || ''));
    const base = path.basename(decodeURIComponent(u.pathname || ''));
    if (base) return base;
  } catch (_) {}
  return path.basename(String(value || '').split('?')[0]) || '';
}
function normalizeManifestUpdateInfo(data) {
  data = data || {};
  const release = data.release || {};
  const asset = release.asset || data.asset || {};
  const latestVersion = normalizeVersion(
    data.latestVersion
    || data.version
    || release.version
    || release.tagName
    || release.tag_name
    || release.name
    || APP_VERSION
  ) || APP_VERSION;
  const downloadUrl = release.downloadUrl || data.downloadUrl || asset.downloadUrl || asset.browser_download_url || '';
  const patch = release.patch || data.patch || null;
  const assetUrls = [downloadUrl].concat(Array.isArray(asset.downloadUrls) ? asset.downloadUrls : []);
  const patchUrls = patch ? [patch.downloadUrl].concat(Array.isArray(patch.downloadUrls) ? patch.downloadUrls : []) : [];
  const patchInfo = patch && patch.downloadUrl ? {
    name: patch.name || updateAssetNameFromUrl(patch.downloadUrl) || `Mineradio-${APP_VERSION}→${latestVersion}.patch.json`,
    size: Number(patch.size || 0) || 0,
    contentType: patch.contentType || patch.content_type || 'application/json',
    downloadUrl: patch.downloadUrl,
    downloadUrls: publicDownloadUrls(uniqueDownloadCandidates(patchUrls)),
    from: normalizeVersion(patch.from || APP_VERSION),
    to: normalizeVersion(patch.to || latestVersion),
    sha256: normalizeDigest(patch.sha256 || '', 'sha256').toLowerCase(),
    sha512: normalizeDigest(patch.sha512 || '', 'sha512'),
  } : null;
  const notes = Array.isArray(release.notes) && release.notes.length
    ? release.notes.slice(0, 4).map(cleanReleaseLine).filter(Boolean)
    : (extractReleaseNotes(release.body || data.body).length ? extractReleaseNotes(release.body || data.body) : UPDATE_FALLBACK_NOTES);
  const assetInfo = downloadUrl ? {
    name: asset.name || updateAssetNameFromUrl(downloadUrl) || `Mineradio-${latestVersion}-Setup.exe`,
    size: Number(asset.size || 0) || 0,
    contentType: asset.contentType || asset.content_type || '',
    downloadUrl,
    downloadUrls: publicDownloadUrls(uniqueDownloadCandidates(assetUrls)),
    sha256: normalizeDigest(asset.sha256 || '', 'sha256').toLowerCase(),
    sha512: normalizeDigest(asset.sha512 || release.sha512 || data.sha512 || '', 'sha512'),
  } : null;
  return {
    configured: true,
    preview: false,
    updateAvailable: data.updateAvailable != null ? !!data.updateAvailable : compareVersions(latestVersion, APP_VERSION) > 0,
    currentVersion: APP_VERSION,
    latestVersion,
    release: {
      tagName: release.tagName || release.tag_name || data.tagName || ('v' + latestVersion),
      name: release.name || data.name || ('Mineradio v' + latestVersion),
      version: latestVersion,
      publishedAt: release.publishedAt || release.published_at || data.publishedAt || '',
      htmlUrl: release.htmlUrl || release.html_url || data.htmlUrl || '',
      downloadUrl,
      asset: assetInfo,
      patch: patchInfo,
      patchAvailable: !!(patchInfo && patchInfo.downloadUrl && compareVersions(latestVersion, APP_VERSION) > 0),
      summary: release.summary || data.summary || notes[0] || '发现新版本，建议更新。',
      notes,
    },
    source: 'manifest',
  };
}
async function readUpdateManifest(ref) {
  const value = String(ref || '').trim();
  if (!value) throw new Error('UPDATE_MANIFEST_MISSING');
  if (/^https?:\/\//i.test(value)) {
    const resp = await fetch(value, {
      headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
    });
    if (!resp.ok) throw new Error('Update manifest ' + resp.status);
    return resp.json();
  }
  const file = /^file:/i.test(value) ? fileURLToPath(value) : path.resolve(value);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
async function fetchManifestUpdateInfo(ref) {
  try {
    const data = await readUpdateManifest(ref);
    return normalizeManifestUpdateInfo(data);
  } catch (err) {
    return localUpdateFallback(err.message || 'Update manifest failed', { configured: true });
  }
}
function beatCacheRootInfo() {
  const dir = path.resolve(BEATMAP_CACHE_DIR);
  const root = path.parse(dir).root;
  const drive = root ? root.replace(/[\\\/]+$/, '').toUpperCase() : '';
  const allowed = !!root && !/^C:$/i.test(drive);
  const available = allowed && fs.existsSync(root);
  return { dir, root, drive, allowed, available };
}
function ensureBeatMapCacheDir() {
  const info = beatCacheRootInfo();
  if (!info.allowed) {
    const err = new Error('BEAT_CACHE_ON_C_DRIVE_DISABLED');
    err.code = 'BEAT_CACHE_ON_C_DRIVE_DISABLED';
    err.info = info;
    throw err;
  }
  if (!info.available) {
    const err = new Error('BEAT_CACHE_DRIVE_UNAVAILABLE');
    err.code = 'BEAT_CACHE_DRIVE_UNAVAILABLE';
    err.info = info;
    throw err;
  }
  fs.mkdirSync(info.dir, { recursive: true });
  return info.dir;
}
function safeBeatMapCacheFile(key) {
  const raw = String(key || '').trim();
  if (!raw || raw.length > 240) return null;
  const hash = crypto.createHash('sha1').update(raw).digest('hex');
  const label = raw.replace(/[^a-z0-9_.-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'beatmap';
  return path.join(ensureBeatMapCacheDir(), `${label}-${hash}.json`);
}
function compactBeatMapCachePayload(body) {
  const key = String(body && body.key || '').trim();
  const map = body && body.map;
  if (!key || !map || typeof map !== 'object') return null;
  return {
    v: 1,
    key,
    savedAt: Date.now(),
    meta: {
      provider: String(body.provider || '').slice(0, 32),
      title: String(body.title || '').slice(0, 160),
      artist: String(body.artist || '').slice(0, 160),
      mode: String(body.mode || 'mr').slice(0, 32),
    },
    map,
  };
}
function readBeatMapCache(key) {
  const file = safeBeatMapCacheFile(key);
  if (!file || !fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return raw && raw.map ? raw : null;
}
function writeBeatMapCache(body) {
  const payload = compactBeatMapCachePayload(body);
  if (!payload) return { ok: false, error: 'INVALID_BEATMAP_CACHE_PAYLOAD' };
  const file = safeBeatMapCacheFile(payload.key);
  if (!file) return { ok: false, error: 'INVALID_BEATMAP_CACHE_KEY' };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, file);
  return { ok: true, key: payload.key, savedAt: payload.savedAt, dir: path.dirname(file) };
}
function localUpdateFallback(reason, opts) {
  opts = opts || {};
  const configured = !!(opts.configured != null ? opts.configured : false);
  return {
    configured,
    preview: UPDATE_CONFIG.preview,
    updateAvailable: false,
    currentVersion: APP_VERSION,
    latestVersion: APP_VERSION,
    release: {
      tagName: 'v' + APP_VERSION,
      name: 'Mineradio v' + APP_VERSION,
      version: APP_VERSION,
      htmlUrl: '',
      downloadUrl: '',
      summary: '当前版本，更新检测已就绪。',
      notes: UPDATE_FALLBACK_NOTES,
    },
    reason: reason || '',
  };
}
function updateError(code, message, cause) {
  const err = new Error(message || code);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}
function classifyUpdateError(err) {
  const code = String(err && err.code || '').trim();
  const message = String(err && err.message || err || '').trim();
  const detail = message || code || '未知错误';
  if (/HASH|DIGEST|CHECKSUM/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_HASH_MISMATCH', reason: '文件校验失败，可能是线路缓存异常，已拦截该安装包。', detail };
  }
  if (/SIZE_MISMATCH|content length/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_SIZE_MISMATCH', reason: '下载文件大小不一致，可能是网络中断或线路缓存不完整。', detail };
  }
  if (/AbortError|TIMEOUT|ETIMEDOUT|timeout/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_TIMEOUT', reason: '连接超时，当前网络到更新线路不稳定。', detail };
  }
  if (/ENOTFOUND|EAI_AGAIN|DNS|fetch failed|getaddrinfo/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_DNS_FAILED', reason: '域名解析失败，可能是当前网络无法连接该更新线路。', detail };
  }
  if (/ECONNRESET|ECONNREFUSED|socket|network/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_NETWORK_FAILED', reason: '网络连接被中断，已尝试切换更新线路。', detail };
  }
  const http = message.match(/\bHTTP[_\s-]?(\d{3})\b/i) || message.match(/\b(\d{3})\b/);
  if (http) {
    const status = Number(http[1]);
    if (status === 403) return { code: code || 'UPDATE_HTTP_403', reason: '更新线路返回 403，可能被限流或拦截。', detail };
    if (status === 404) return { code: code || 'UPDATE_HTTP_404', reason: '更新文件不存在，可能 release 资源还没有同步完成。', detail };
    if (status >= 500) return { code: code || 'UPDATE_HTTP_5XX', reason: '更新线路服务器异常，请稍后重试。', detail };
    return { code: code || ('UPDATE_HTTP_' + status), reason: '更新线路返回 HTTP ' + status + '。', detail };
  }
  return { code: code || 'UPDATE_FAILED', reason: '更新失败：' + detail, detail };
}
async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 12000);
  try {
    return await fetch(url, Object.assign({}, opts || {}, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}
async function fetchTextFromCandidates(candidates, timeoutMs) {
  const list = Array.isArray(candidates) && candidates.length ? candidates : [];
  const failures = [];
  for (let i = 0; i < list.length; i++) {
    const candidate = list[i];
    try {
      const resp = await fetchWithTimeout(candidate.url, {
        headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
      }, timeoutMs || 6500);
      if (!resp.ok) throw updateError('HTTP_' + resp.status, 'HTTP ' + resp.status);
      return { text: await resp.text(), candidate };
    } catch (err) {
      const info = classifyUpdateError(err);
      failures.push(candidate.label + ': ' + info.reason);
    }
  }
  throw updateError('UPDATE_ALL_LINES_FAILED', failures.join('；') || 'All update lines failed');
}
function yamlScalar(text, key) {
  const pattern = new RegExp('^\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(.+?)\\s*$', 'm');
  const match = String(text || '').match(pattern);
  if (!match) return '';
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}
function githubReleaseDownloadUrl(version, fileName) {
  const tag = 'v' + normalizeVersion(version);
  const encodedOwner = encodeURIComponent(UPDATE_CONFIG.owner);
  const encodedRepo = encodeURIComponent(UPDATE_CONFIG.repo);
  const encodedName = String(fileName || '').split('/').map(part => encodeURIComponent(part)).join('/');
  return `https://github.com/${encodedOwner}/${encodedRepo}/releases/download/${tag}/${encodedName}`;
}
function parseLatestYmlUpdateInfo(text, reason) {
  const latestVersion = normalizeVersion(yamlScalar(text, 'version') || APP_VERSION) || APP_VERSION;
  const assetPath = yamlScalar(text, 'path') || yamlScalar(text, 'url') || `Mineradio-${latestVersion}-Setup.exe`;
  const sha512 = normalizeDigest(yamlScalar(text, 'sha512'), 'sha512');
  const size = Number(yamlScalar(text, 'size') || 0) || 0;
  const releaseDate = yamlScalar(text, 'releaseDate');
  const downloadUrl = githubReleaseDownloadUrl(latestVersion, assetPath);
  const candidates = uniqueDownloadCandidates(downloadUrl);
  const asset = {
    name: updateAssetNameFromUrl(downloadUrl) || assetPath,
    size,
    contentType: 'application/octet-stream',
    downloadUrl,
    downloadUrls: publicDownloadUrls(candidates),
    sha256: '',
    sha512,
  };
  return {
    configured: true,
    preview: false,
    updateAvailable: compareVersions(latestVersion, APP_VERSION) > 0,
    currentVersion: APP_VERSION,
    latestVersion,
    release: {
      tagName: 'v' + latestVersion,
      name: 'Mineradio v' + latestVersion,
      version: latestVersion,
      publishedAt: releaseDate,
      htmlUrl: `https://github.com/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/releases/tag/v${latestVersion}`,
      downloadUrl,
      asset,
      patch: null,
      patchAvailable: false,
      summary: '发现新版本，已启用备用更新线路。',
      notes: ['更新检测已切换到备用线路', '下载时会自动选择国内加速线路', '下载失败会显示具体原因和当前速度'],
    },
    source: 'latest-yml',
    reason: reason || '',
  };
}
async function fetchLatestYmlUpdateInfo(reason) {
  if (!UPDATE_CONFIG.configured || UPDATE_CONFIG.provider !== 'github') throw updateError('UPDATE_REPOSITORY_NOT_CONFIGURED');
  const latestYmlUrl = `https://github.com/${encodeURIComponent(UPDATE_CONFIG.owner)}/${encodeURIComponent(UPDATE_CONFIG.repo)}/releases/latest/download/latest.yml`;
  const candidates = uniqueDownloadCandidates(latestYmlUrl);
  const result = await fetchTextFromCandidates(candidates, 6500);
  return parseLatestYmlUpdateInfo(result.text, reason);
}
async function fetchLatestUpdateInfo() {
  if (UPDATE_CONFIG.manifest) return fetchManifestUpdateInfo(UPDATE_CONFIG.manifest);
  if (!UPDATE_CONFIG.configured || UPDATE_CONFIG.provider !== 'github') return localUpdateFallback();
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(UPDATE_CONFIG.owner)}/${encodeURIComponent(UPDATE_CONFIG.repo)}/releases/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8500);
  try {
    const resp = await fetch(apiUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': `Mineradio/${APP_VERSION}`,
        'Accept': 'application/vnd.github+json',
      },
    });
    if (!resp.ok) {
      try { return await fetchLatestYmlUpdateInfo('GitHub Releases ' + resp.status); }
      catch (_) { return localUpdateFallback('GitHub Releases ' + resp.status, { configured: true }); }
    }
    const data = await resp.json();
    const latestVersion = normalizeVersion(data.tag_name || data.name || APP_VERSION) || APP_VERSION;
    const asset = pickReleaseAsset(data.assets);
    const patch = pickPatchAsset(data.assets, APP_VERSION, latestVersion);
    const notes = extractReleaseNotes(data.body).length ? extractReleaseNotes(data.body) : UPDATE_FALLBACK_NOTES;
    return {
      configured: true,
      preview: false,
      updateAvailable: compareVersions(latestVersion, APP_VERSION) > 0,
      currentVersion: APP_VERSION,
      latestVersion,
      release: {
        tagName: data.tag_name || ('v' + latestVersion),
        name: data.name || ('Mineradio v' + latestVersion),
        version: latestVersion,
        publishedAt: data.published_at || '',
        htmlUrl: data.html_url || '',
        downloadUrl: asset ? asset.downloadUrl : '',
        asset,
        patch,
        patchAvailable: !!(patch && patch.downloadUrl && compareVersions(latestVersion, APP_VERSION) > 0),
        summary: notes[0] || '发现新版本，建议更新。',
        notes,
      },
    };
  } catch (err) {
    const reason = err && err.message || 'Update check failed';
    try { return await fetchLatestYmlUpdateInfo(reason); }
    catch (fallbackErr) { return localUpdateFallback((fallbackErr && fallbackErr.message) || reason, { configured: true }); }
  } finally {
    clearTimeout(timer);
  }
}
function safeUpdateFileName(name, version) {
  const raw = String(name || '').trim() || `Mineradio-${version || APP_VERSION}.exe`;
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return cleaned || `Mineradio-${version || APP_VERSION}.exe`;
}
function publicUpdateJob(job) {
  if (!job) return { ok: false, error: 'UPDATE_JOB_NOT_FOUND' };
  return {
    ok: job.status !== 'error',
    id: job.id,
    status: job.status,
    progress: job.progress || 0,
    received: job.received || 0,
    total: job.total || 0,
    speedBps: job.speedBps || 0,
    etaSeconds: job.etaSeconds || 0,
    sourceLabel: job.sourceLabel || '',
    attempt: job.attempt || 0,
    attempts: job.attempts || 0,
    mode: job.mode || 'installer',
    message: job.message || '',
    restartRequired: !!job.restartRequired,
    cached: !!job.cached,
    fileName: job.fileName || '',
    filePath: job.status === 'ready' ? job.filePath : '',
    version: job.version || '',
    releaseUrl: job.releaseUrl || '',
    error: job.error || '',
    errorReason: job.errorReason || '',
    errorDetail: job.errorDetail || '',
    failedAttempts: Array.isArray(job.failedAttempts) ? job.failedAttempts.slice(0, 6) : [],
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
function activeUpdateJobFor(version) {
  const jobs = Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return jobs.find(job => job.version === version && (job.status === 'queued' || job.status === 'downloading' || job.status === 'ready'));
}
function trimUpdateJobs() {
  const jobs = Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  jobs.slice(8).forEach(job => updateDownloadJobs.delete(job.id));
}
async function downloadUpdateAsset(job) {
  const tmpPath = job.filePath + '.download';
  try {
    fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
    job.status = 'downloading';
    job.updatedAt = Date.now();

    const resp = await fetch(job.downloadUrl, {
      headers: {
        'User-Agent': `Mineradio/${APP_VERSION}`,
      },
    });
    if (!resp.ok) throw new Error('Download failed ' + resp.status);

    const totalHeader = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
    job.total = totalHeader || job.total || 0;
    job.received = 0;
    job.progress = 0;
    job.speedBps = 0;
    job.etaSeconds = 0;
    job.message = job.total ? '正在下载完整安装包' : '正在下载完整安装包，等待服务器返回大小';
    job.updatedAt = Date.now();
    let speedWindowAt = Date.now();
    let speedWindowBytes = 0;

    const writer = fs.createWriteStream(tmpPath);
    const reader = resp.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const buf = Buffer.from(chunk.value);
        job.received += buf.length;
        speedWindowBytes += buf.length;
        const now = Date.now();
        if (now - speedWindowAt >= 900) {
          job.speedBps = Math.round(speedWindowBytes / Math.max(0.001, (now - speedWindowAt) / 1000));
          speedWindowAt = now;
          speedWindowBytes = 0;
        }
        if (job.total > 0) {
          job.progress = Math.max(1, Math.min(99, Math.round((job.received / job.total) * 100)));
          job.etaSeconds = job.speedBps > 0 ? Math.max(0, Math.round((job.total - job.received) / job.speedBps)) : 0;
        } else {
          const kb = Math.max(1, job.received / 1024);
          job.progress = Math.max(1, Math.min(88, Math.round(Math.log10(kb + 1) * 24)));
        }
        job.message = job.total > 0 ? '正在下载完整安装包' : '正在下载完整安装包，服务器未提供总大小';
        job.updatedAt = Date.now();
        if (!writer.write(buf)) await once(writer, 'drain');
      }
    } finally {
      writer.end();
      await once(writer, 'finish').catch(() => {});
    }

    if (fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath);
    fs.renameSync(tmpPath, job.filePath);
    job.status = 'ready';
    job.progress = 100;
    job.message = '安装包已下载';
    job.updatedAt = Date.now();
  } catch (e) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    job.status = 'error';
    job.error = e.message || 'UPDATE_DOWNLOAD_FAILED';
    job.updatedAt = Date.now();
  }
}
function sha512Base64(buffer) {
  return crypto.createHash('sha512').update(buffer).digest('base64');
}
function sha512Hex(buffer) {
  return crypto.createHash('sha512').update(buffer).digest('hex');
}
function verifyUpdateBuffer(buffer, job) {
  const expectedSize = Number(job.expectedSize || job.total || 0) || 0;
  if (expectedSize > 0 && buffer.length !== expectedSize) {
    throw updateError('UPDATE_SIZE_MISMATCH', `Expected ${expectedSize} bytes, got ${buffer.length}`);
  }
  const expectedSha256 = normalizeDigest(job.sha256 || '', 'sha256').toLowerCase();
  if (expectedSha256 && sha256Hex(buffer) !== expectedSha256) {
    throw updateError('UPDATE_SHA256_MISMATCH', 'Downloaded sha256 mismatch');
  }
  const expectedSha512 = normalizeDigest(job.sha512 || '', 'sha512');
  if (expectedSha512) {
    const actualBase64 = sha512Base64(buffer);
    const actualHex = sha512Hex(buffer).toLowerCase();
    if (actualBase64 !== expectedSha512 && actualHex !== expectedSha512.toLowerCase()) {
      throw updateError('UPDATE_SHA512_MISMATCH', 'Downloaded sha512 mismatch');
    }
  }
}
function verifyUpdateFile(filePath, job) {
  verifyUpdateBuffer(fs.readFileSync(filePath), job);
}
function moveInvalidUpdateFile(filePath, reason) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return;
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    const invalidPath = path.join(dir, `${base}.invalid-${Date.now()}${ext || '.bin'}`);
    fs.renameSync(filePath, invalidPath);
    console.warn('[UpdateDownload] cached installer moved aside:', reason || 'invalid', invalidPath);
  } catch (e) {
    console.warn('[UpdateDownload] failed to move invalid cached installer:', e.message);
  }
}
function reuseVerifiedInstallerJob(opts) {
  if (!opts || !opts.filePath || !fs.existsSync(opts.filePath)) return null;
  if (!opts.expectedSize && !opts.sha256 && !opts.sha512) return null;
  const now = Date.now();
  const stat = fs.statSync(opts.filePath);
  const job = {
    id: 'cached-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    status: 'ready',
    progress: 100,
    received: stat.size || 0,
    total: opts.expectedSize || stat.size || 0,
    speedBps: 0,
    etaSeconds: 0,
    sourceLabel: '本地缓存',
    attempt: 0,
    attempts: opts.attempts || 0,
    mode: 'installer',
    message: '安装包已下载，可直接打开安装',
    fileName: opts.fileName || path.basename(opts.filePath),
    filePath: opts.filePath,
    version: opts.version || '',
    downloadUrl: opts.downloadUrl || '',
    downloadCandidates: opts.downloadCandidates || [],
    expectedSize: opts.expectedSize || 0,
    sha256: opts.sha256 || '',
    sha512: opts.sha512 || '',
    releaseUrl: opts.releaseUrl || '',
    failedAttempts: [],
    cached: true,
    createdAt: now,
    updatedAt: now,
    error: '',
  };
  try {
    verifyUpdateFile(opts.filePath, job);
    updateDownloadJobs.set(job.id, job);
    trimUpdateJobs();
    return job;
  } catch (err) {
    moveInvalidUpdateFile(opts.filePath, (err && err.message) || 'cache verification failed');
    return null;
  }
}
function setUpdateJobError(job, err, fallbackMessage) {
  const info = classifyUpdateError(err);
  job.status = 'error';
  job.error = info.code;
  job.errorReason = info.reason;
  job.errorDetail = info.detail;
  job.message = fallbackMessage || info.reason;
  job.updatedAt = Date.now();
}
function prepareUpdateJobAttempt(job, candidate, index, total) {
  job.status = 'downloading';
  job.sourceLabel = candidate.label || '下载线路';
  job.attempt = index + 1;
  job.attempts = total;
  job.received = 0;
  job.speedBps = 0;
  job.etaSeconds = 0;
  job.error = '';
  job.errorReason = '';
  job.errorDetail = '';
  job.updatedAt = Date.now();
}
function ensureMirrorCanBeVerified(job, candidate) {
  if (!candidate || !candidate.mirrored) return;
  if (job.sha256 || job.sha512) return;
  throw updateError('MIRROR_HASH_MISSING', 'Mirror download skipped because no digest is available');
}
async function downloadUpdateAssetWithMirrors(job) {
  const tmpPath = job.filePath + '.download';
  const candidates = Array.isArray(job.downloadCandidates) && job.downloadCandidates.length
    ? job.downloadCandidates
    : uniqueDownloadCandidates(job.downloadUrl || '');
  const failures = [];
  fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
      ensureMirrorCanBeVerified(job, candidate);
      prepareUpdateJobAttempt(job, candidate, i, candidates.length);
      job.message = job.total ? '正在下载完整安装包' : '正在下载完整安装包，等待服务器返回大小';

      const resp = await fetchWithTimeout(candidate.url, {
        headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
      }, 14000);
      if (!resp.ok) throw updateError('HTTP_' + resp.status, 'HTTP ' + resp.status);

      const totalHeader = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
      job.total = totalHeader || job.expectedSize || job.total || 0;
      job.progress = 0;
      job.updatedAt = Date.now();
      let speedWindowAt = Date.now();
      let speedWindowBytes = 0;

      const writer = fs.createWriteStream(tmpPath);
      const reader = resp.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const buf = Buffer.from(chunk.value);
          job.received += buf.length;
          speedWindowBytes += buf.length;
          const now = Date.now();
          if (now - speedWindowAt >= 900) {
            job.speedBps = Math.round(speedWindowBytes / Math.max(0.001, (now - speedWindowAt) / 1000));
            speedWindowAt = now;
            speedWindowBytes = 0;
          }
          if (job.total > 0) {
            job.progress = Math.max(1, Math.min(99, Math.round((job.received / job.total) * 100)));
            job.etaSeconds = job.speedBps > 0 ? Math.max(0, Math.round((job.total - job.received) / job.speedBps)) : 0;
          } else {
            const kb = Math.max(1, job.received / 1024);
            job.progress = Math.max(1, Math.min(88, Math.round(Math.log10(kb + 1) * 24)));
          }
          job.message = job.total > 0 ? '正在下载完整安装包' : '正在下载完整安装包，服务器未提供总大小';
          job.updatedAt = Date.now();
          if (!writer.write(buf)) await once(writer, 'drain');
        }
      } finally {
        writer.end();
        await once(writer, 'finish').catch(() => {});
      }

      verifyUpdateFile(tmpPath, job);
      if (fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath);
      fs.renameSync(tmpPath, job.filePath);
      job.status = 'ready';
      job.progress = 100;
      job.etaSeconds = 0;
      job.message = '安装包已下载';
      job.updatedAt = Date.now();
      return;
    } catch (err) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
      const info = classifyUpdateError(err);
      failures.push({ source: candidate.label || '下载线路', reason: info.reason, detail: info.detail });
      job.failedAttempts = failures.slice(-6);
      job.message = i < candidates.length - 1 ? ((candidate.label || '当前线路') + '失败，正在切换线路') : info.reason;
      job.updatedAt = Date.now();
      if (i >= candidates.length - 1) setUpdateJobError(job, err, '下载失败：' + info.reason);
    }
  }
}
function startUpdateDownloadJob(info) {
  const release = info && info.release ? info.release : {};
  const asset = release.asset || {};
  const downloadUrl = release.downloadUrl || asset.downloadUrl || '';
  if (!info || !info.configured) return { ok: false, error: 'UPDATE_REPOSITORY_NOT_CONFIGURED' };
  if (!info.updateAvailable) return { ok: false, error: 'NO_UPDATE_AVAILABLE' };
  if (!/^https?:\/\//i.test(downloadUrl)) return { ok: false, error: 'UPDATE_ASSET_MISSING' };

  const version = info.latestVersion || release.version || '';
  const existing = activeUpdateJobFor(version);
  if (existing) return publicUpdateJob(existing);

  const fileName = safeUpdateFileName(asset.name || '', version);
  const filePath = path.join(UPDATE_DOWNLOAD_DIR, fileName);
  const downloadCandidates = uniqueDownloadCandidates([downloadUrl].concat(Array.isArray(asset.downloadUrls) ? asset.downloadUrls : []));
  const expectedSize = asset.size || 0;
  const sha256 = normalizeDigest(asset.sha256 || '', 'sha256').toLowerCase();
  const sha512 = normalizeDigest(asset.sha512 || '', 'sha512');
  const cached = reuseVerifiedInstallerJob({
    fileName,
    filePath,
    version,
    downloadUrl,
    downloadCandidates,
    expectedSize,
    sha256,
    sha512,
    releaseUrl: release.htmlUrl || '',
    attempts: downloadCandidates.length,
  });
  if (cached) return publicUpdateJob(cached);

  const now = Date.now();
  const job = {
    id: now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    status: 'queued',
    progress: 0,
    received: 0,
    total: expectedSize,
    mode: 'installer',
    fileName,
    filePath,
    version,
    downloadUrl,
    downloadCandidates,
    expectedSize,
    sha256,
    sha512,
    releaseUrl: release.htmlUrl || '',
    sourceLabel: '',
    attempt: 0,
    attempts: downloadCandidates.length,
    failedAttempts: [],
    createdAt: now,
    updatedAt: now,
    error: '',
  };
  updateDownloadJobs.set(job.id, job);
  trimUpdateJobs();
  downloadUpdateAssetWithMirrors(job);
  return publicUpdateJob(job);
}
function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
function safePatchRelativePath(value) {
  const rel = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!rel || rel.includes('\0')) return '';
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '..' || part === '.')) return '';
  const root = parts[0];
  if (PATCH_ALLOWED_FILES.has(rel)) return rel;
  if (!PATCH_ALLOWED_ROOTS.has(root)) return '';
  if (/\.(exe|dll|node|msi|bat|cmd|ps1|pfx|pem|key)$/i.test(rel)) return '';
  return parts.join('/');
}
function patchTargetPath(rel) {
  const safeRel = safePatchRelativePath(rel);
  if (!safeRel) return null;
  const target = path.resolve(__dirname, safeRel);
  const root = path.resolve(__dirname);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}
function decodePatchFile(file) {
  if (!file || typeof file !== 'object') return null;
  if (typeof file.contentBase64 === 'string') return Buffer.from(file.contentBase64, 'base64');
  if (typeof file.content === 'string') return Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
  return null;
}
function backupPatchTarget(job, rel, target) {
  if (!fs.existsSync(target)) return;
  const backup = path.join(UPDATE_PATCH_BACKUP_DIR, job.id, rel);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(target, backup);
}
function writePatchFile(job, file) {
  const rel = safePatchRelativePath(file.path || file.name);
  const target = rel ? patchTargetPath(rel) : null;
  const content = decodePatchFile(file);
  if (!rel || !target || !content) throw new Error('INVALID_PATCH_FILE');
  if (content.length > PATCH_MAX_BYTES) throw new Error('PATCH_FILE_TOO_LARGE');
  const expected = String(file.sha256 || '').trim().toLowerCase();
  const actual = sha256Hex(content);
  if (expected && expected !== actual) throw new Error('PATCH_HASH_MISMATCH:' + rel);
  backupPatchTarget(job, rel, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.mineradio-patch';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
  if (expected && sha256Hex(fs.readFileSync(target)) !== expected) throw new Error('PATCH_WRITE_VERIFY_FAILED:' + rel);
  return rel;
}
function normalizePatchPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('INVALID_PATCH_PAYLOAD');
  const type = String(payload.type || payload.kind || '');
  if (type && type !== 'mineradio-resource-patch') throw new Error('UNSUPPORTED_PATCH_TYPE');
  const from = normalizeVersion(payload.from || payload.baseVersion || '');
  const to = normalizeVersion(payload.to || payload.version || payload.targetVersion || '');
  const files = Array.isArray(payload.files) ? payload.files : [];
  if (!from || compareVersions(from, APP_VERSION) !== 0) throw new Error('PATCH_VERSION_MISMATCH');
  if (!to || compareVersions(to, APP_VERSION) <= 0) throw new Error('PATCH_TARGET_VERSION_INVALID');
  if (!files.length) throw new Error('PATCH_EMPTY');
  if (files.length > 40) throw new Error('PATCH_TOO_MANY_FILES');
  return { from, to, files, restartRequired: payload.restartRequired !== false };
}
async function downloadAndApplyPatch(job) {
  const chunks = [];
  try {
    fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
    job.status = 'downloading';
    job.mode = 'patch';
    job.message = '正在下载快速补丁';
    job.updatedAt = Date.now();

    const resp = await fetch(job.downloadUrl, {
      headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
    });
    if (!resp.ok) throw new Error('Patch download failed ' + resp.status);

    job.total = parseInt(resp.headers.get('content-length') || '0', 10) || job.total || 0;
    job.received = 0;
    const reader = resp.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const buf = Buffer.from(chunk.value);
      job.received += buf.length;
      if (job.received > PATCH_MAX_BYTES) throw new Error('PATCH_TOO_LARGE');
      chunks.push(buf);
      job.progress = job.total > 0
        ? Math.max(1, Math.min(84, Math.round((job.received / job.total) * 84)))
        : Math.max(1, Math.min(76, Math.round(Math.log10(job.received / 1024 + 1) * 24)));
      job.updatedAt = Date.now();
    }

    const raw = Buffer.concat(chunks);
    const expectedPatchHash = String(job.sha256 || '').trim().toLowerCase();
    if (expectedPatchHash && sha256Hex(raw) !== expectedPatchHash) throw new Error('PATCH_PACKAGE_HASH_MISMATCH');
    const patch = normalizePatchPayload(JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')));
    job.version = patch.to;
    job.message = '正在应用快速补丁';
    job.progress = 88;
    job.updatedAt = Date.now();
    const changed = [];
    patch.files.forEach(file => changed.push(writePatchFile(job, file)));
    job.changedFiles = changed;
    job.status = 'ready';
    job.progress = 100;
    job.restartRequired = patch.restartRequired;
    job.message = patch.restartRequired ? '快速补丁已应用，重启后生效' : '快速补丁已应用';
    job.updatedAt = Date.now();
  } catch (e) {
    job.status = 'error';
    job.error = e.message || 'PATCH_APPLY_FAILED';
    job.message = '快速补丁失败，可改用完整安装包';
    job.updatedAt = Date.now();
  }
}
async function downloadPatchBufferFromCandidate(job, candidate, index, total) {
  ensureMirrorCanBeVerified(job, candidate);
  prepareUpdateJobAttempt(job, candidate, index, total);
  job.mode = 'patch';
  job.message = '正在下载快速补丁';
  job.progress = 0;
  job.updatedAt = Date.now();

  const resp = await fetchWithTimeout(candidate.url, {
    headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
  }, 12000);
  if (!resp.ok) throw updateError('HTTP_' + resp.status, 'HTTP ' + resp.status);

  job.total = parseInt(resp.headers.get('content-length') || '0', 10) || job.expectedSize || job.total || 0;
  job.received = 0;
  const chunks = [];
  const reader = resp.body.getReader();
  let speedWindowAt = Date.now();
  let speedWindowBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const buf = Buffer.from(chunk.value);
    job.received += buf.length;
    speedWindowBytes += buf.length;
    if (job.received > PATCH_MAX_BYTES) throw updateError('PATCH_TOO_LARGE', 'Patch package is too large');
    chunks.push(buf);
    const now = Date.now();
    if (now - speedWindowAt >= 700) {
      job.speedBps = Math.round(speedWindowBytes / Math.max(0.001, (now - speedWindowAt) / 1000));
      speedWindowAt = now;
      speedWindowBytes = 0;
    }
    job.progress = job.total > 0
      ? Math.max(1, Math.min(84, Math.round((job.received / job.total) * 84)))
      : Math.max(1, Math.min(76, Math.round(Math.log10(job.received / 1024 + 1) * 24)));
    job.etaSeconds = job.total > 0 && job.speedBps > 0 ? Math.max(0, Math.round((job.total - job.received) / job.speedBps)) : 0;
    job.updatedAt = Date.now();
  }
  const raw = Buffer.concat(chunks);
  verifyUpdateBuffer(raw, job);
  return raw;
}
async function downloadAndApplyPatchWithMirrors(job) {
  const candidates = Array.isArray(job.downloadCandidates) && job.downloadCandidates.length
    ? job.downloadCandidates
    : uniqueDownloadCandidates(job.downloadUrl || '');
  const failures = [];
  fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const raw = await downloadPatchBufferFromCandidate(job, candidate, i, candidates.length);
      const patch = normalizePatchPayload(JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')));
      job.version = patch.to;
      job.message = '正在应用快速补丁';
      job.progress = 88;
      job.etaSeconds = 0;
      job.updatedAt = Date.now();
      const changed = [];
      patch.files.forEach(file => changed.push(writePatchFile(job, file)));
      job.changedFiles = changed;
      job.status = 'ready';
      job.progress = 100;
      job.restartRequired = patch.restartRequired;
      job.message = patch.restartRequired ? '快速补丁已应用，重启后生效' : '快速补丁已应用';
      job.updatedAt = Date.now();
      return;
    } catch (err) {
      const info = classifyUpdateError(err);
      failures.push({ source: candidate.label || '下载线路', reason: info.reason, detail: info.detail });
      job.failedAttempts = failures.slice(-6);
      job.message = i < candidates.length - 1 ? ((candidate.label || '当前线路') + '失败，正在切换线路') : info.reason;
      job.updatedAt = Date.now();
      if (i >= candidates.length - 1) setUpdateJobError(job, err, '快速补丁失败：' + info.reason);
    }
  }
}
function startUpdatePatchJob(info) {
  const release = info && info.release ? info.release : {};
  const patch = release.patch || {};
  const downloadUrl = patch.downloadUrl || '';
  if (!info || !info.configured) return { ok: false, error: 'UPDATE_REPOSITORY_NOT_CONFIGURED' };
  if (!info.updateAvailable) return { ok: false, error: 'NO_UPDATE_AVAILABLE' };
  if (!release.patchAvailable || !/^https?:\/\//i.test(downloadUrl)) return { ok: false, error: 'PATCH_ASSET_MISSING' };

  const version = info.latestVersion || release.version || patch.to || '';
  const existing = Array.from(updateDownloadJobs.values())
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .find(job => job.mode === 'patch' && job.version === version && (job.status === 'queued' || job.status === 'downloading' || job.status === 'ready'));
  if (existing) return publicUpdateJob(existing);

  const now = Date.now();
  const downloadCandidates = uniqueDownloadCandidates([downloadUrl].concat(Array.isArray(patch.downloadUrls) ? patch.downloadUrls : []));
  const job = {
    id: 'patch-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    status: 'queued',
    progress: 0,
    received: 0,
    total: patch.size || 0,
    mode: 'patch',
    fileName: patch.name || safeUpdateFileName('', version).replace(/\.exe$/i, '.patch.json'),
    filePath: '',
    version,
    downloadUrl,
    downloadCandidates,
    releaseUrl: release.htmlUrl || '',
    expectedSize: patch.size || 0,
    sha256: normalizeDigest(patch.sha256 || '', 'sha256').toLowerCase(),
    sha512: normalizeDigest(patch.sha512 || '', 'sha512'),
    restartRequired: true,
    sourceLabel: '',
    attempt: 0,
    attempts: downloadCandidates.length,
    failedAttempts: [],
    message: '等待下载快速补丁',
    createdAt: now,
    updatedAt: now,
    error: '',
  };
  updateDownloadJobs.set(job.id, job);
  trimUpdateJobs();
  downloadAndApplyPatchWithMirrors(job);
  return publicUpdateJob(job);
}
function readRequestBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 8 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch (e) {
        const params = new URLSearchParams(raw);
        const out = {};
        params.forEach((v, k) => { out[k] = v; });
        resolve(out);
      }
    });
    req.on('error', () => resolve({}));
  });
}
function normalizeApiCode(payload) {
  const body = payload && (payload.body || payload);
  return Number((body && body.code) || (body && body.body && body.body.code) || (payload && payload.status) || 0);
}
function normalizeApiMessage(payload) {
  const body = payload && (payload.body || payload);
  return (body && (body.message || body.msg || body.error)) || (body && body.body && (body.body.message || body.body.msg || body.body.error)) || '';
}
function parseCookieString(cookieText) {
  const out = {};
  String(cookieText || '').split(';').forEach(part => {
    const raw = String(part || '').trim();
    if (!raw) return;
    const idx = raw.indexOf('=');
    if (idx <= 0) return;
    const key = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (key) out[key] = value;
  });
  return out;
}
function serializeCookieObject(obj) {
  return Object.keys(obj || {})
    .filter(k => obj[k] != null && String(obj[k]) !== '')
    .map(k => k + '=' + String(obj[k]))
    .join('; ');
}
function qqCookieObject() {
  return parseCookieString(qqCookie);
}
function normalizeQQUin(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.replace(/^0+/, '') || digits;
}
function qqCookieUin(obj) {
  obj = obj || qqCookieObject();
  const raw = Number(obj.login_type) === 2 ? (obj.wxuin || obj.uin || obj.p_uin) : (obj.uin || obj.qqmusic_uin || obj.wxuin || obj.p_uin);
  return normalizeQQUin(raw);
}
function qqCookieMusicKey(obj) {
  obj = obj || qqCookieObject();
  return obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.p_skey || obj.skey ||
    obj.psrf_qqaccess_token || obj.psrf_qqrefresh_token || obj.wxrefresh_token || obj.wxskey || '';
}
function qqCookiePlaybackKey(obj) {
  obj = obj || qqCookieObject();
  return obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.wxskey || '';
}
function decodeQQCookieValue(value) {
  try { return decodeURIComponent(String(value || '').replace(/\+/g, '%20')).trim(); }
  catch (e) { return String(value || '').trim(); }
}
function qqCookieNickname(obj, uin) {
  obj = obj || qqCookieObject();
  uin = normalizeQQUin(uin || qqCookieUin(obj));
  const padded = uin ? '0' + uin : '';
  const keys = [
    uin && ('ptnick_' + uin),
    padded && ('ptnick_' + padded),
    'ptnick',
    'nick',
    'nickname',
    'qq_nickname'
  ].filter(Boolean);
  for (const key of keys) {
    if (obj[key]) {
      const nick = decodeQQCookieValue(obj[key]);
      if (nick) return nick;
    }
  }
  const ptnickKey = Object.keys(obj).find(key => /^ptnick_/i.test(key) && obj[key]);
  return ptnickKey ? decodeQQCookieValue(obj[ptnickKey]) : '';
}
function qqCookieAvatar(obj, uin) {
  obj = obj || qqCookieObject();
  const direct = obj.qqmusic_avatar || obj.avatar || obj.avatarUrl || obj.headpic || '';
  if (direct) return decodeQQCookieValue(direct);
  uin = normalizeQQUin(uin || qqCookieUin(obj));
  return uin ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=100` : '';
}
function normalizeQQCookieInput(cookieText) {
  const obj = parseCookieString(cookieText);
  if (Number(obj.login_type) === 2 && obj.wxuin && !obj.uin) obj.uin = obj.wxuin;
  if (!obj.uin && (obj.qqmusic_uin || obj.p_uin)) obj.uin = obj.qqmusic_uin || obj.p_uin;
  if (obj.uin) obj.uin = normalizeQQUin(obj.uin);
  return serializeCookieObject(obj);
}
function playbackRestriction(provider, category, message, action, extra) {
  return {
    provider,
    category,
    action: action || '',
    message,
    ...(extra || {}),
  };
}
function classifyNeteasePlaybackRestriction(lastData, loginInfo) {
  const loggedIn = !!(loginInfo && loginInfo.loggedIn);
  const fee = Number(lastData && lastData.fee);
  const code = Number(lastData && lastData.code);
  const freeTrial = lastData && lastData.freeTrialInfo;
  if (!loggedIn) {
    return playbackRestriction('netease', 'login_required', '网易云需要登录后尝试获取完整播放地址', 'login', { code, fee });
  }
  if (freeTrial) {
    return playbackRestriction('netease', 'trial_only', '网易云仅返回试听片段，完整播放需要会员或购买', 'upgrade', { code, fee });
  }
  if (fee === 1) {
    return playbackRestriction('netease', 'vip_required', '网易云歌曲需要 VIP 权限，当前无法获取完整播放地址', 'upgrade', { code, fee });
  }
  if (fee === 4 || fee === 8) {
    return playbackRestriction('netease', 'paid_required', '网易云歌曲需要单曲、专辑购买或更高权限', 'purchase', { code, fee });
  }
  if (code === 404 || code === 403) {
    return playbackRestriction('netease', 'copyright_unavailable', '网易云版权暂不可播，换源或稍后重试会更稳', 'switch_source', { code, fee });
  }
  return playbackRestriction('netease', 'url_unavailable', '网易云没有返回可播放地址，可能是版权、会员或地区限制', loggedIn ? 'switch_source' : 'login', { code, fee });
}
function classifyQQPlaybackRestriction(info, session) {
  const hasSession = typeof session === 'object' ? !!session.hasSession : !!session;
  const hasPlaybackKey = typeof session === 'object' ? !!session.hasPlaybackKey : hasSession;
  const rawMsg = String((info && (info.msg || info.tips || info.errmsg || info.message)) || '').trim();
  const code = Number((info && (info.result || info.code || info.errtype)) || 0);
  const lower = rawMsg.toLowerCase();
  if (!hasSession) {
    return playbackRestriction('qq', 'login_required', 'QQ 音乐需要登录或授权后才能获取播放地址', 'login', { code, rawMessage: rawMsg });
  }
  if (!hasPlaybackKey && code === 104003) {
    return playbackRestriction('qq', 'login_required', 'QQ 音乐当前只拿到了网页登录状态，还缺少播放授权，请重新打开官方 QQ 音乐登录窗口完成授权', 'login', { code, rawMessage: rawMsg, missingPlaybackKey: true });
  }
  if (code === 104003) {
    return playbackRestriction('qq', 'copyright_unavailable', 'QQ 音乐没有给当前版本返回播放地址，通常是版权、会员或官方版本限制，可以换一个搜索结果或切到网易云源', 'switch_source', { code, rawMessage: rawMsg });
  }
  if (/vip|会员|付费|购买|数字专辑|专辑|pay/.test(lower + rawMsg)) {
    return playbackRestriction('qq', 'paid_required', 'QQ 音乐歌曲需要会员、购买或数字专辑权限', 'upgrade', { code, rawMessage: rawMsg });
  }
  if (code && code !== 0) {
    return playbackRestriction('qq', 'copyright_unavailable', rawMsg || 'QQ 音乐版权暂不可播或仅官方客户端可播', 'switch_source', { code, rawMessage: rawMsg });
  }
  return playbackRestriction('qq', 'url_unavailable', 'QQ 音乐没有返回播放地址，可能受版权、会员或官方客户端限制', 'switch_source', { code, rawMessage: rawMsg });
}
const NETEASE_QUALITY_CANDIDATES = [
  { level: 'jymaster', br: 1999000, label: '超清母带', svip: true },
  { level: 'hires',    br: 1999000, label: '高清臻音' },
  { level: 'lossless', br: 1411000, label: '无损' },
  { level: 'exhigh',   br: 999000,  label: '极高' },
  { level: 'standard', br: 128000,  label: '标准' },
];
const QQ_QUALITY_CANDIDATE_TEMPLATES = [
  { prefix: 'RS01', ext: '.flac', level: 'hires', label: 'Hi-Res FLAC' },
  { prefix: 'F000', ext: '.flac', level: 'lossless', label: '无损 FLAC' },
  { prefix: 'M800', ext: '.mp3', level: 'exhigh', label: '320k MP3' },
  { prefix: 'M500', ext: '.mp3', level: 'standard', label: '128k MP3' },
  { prefix: 'C400', ext: '.m4a', level: 'aac', label: 'AAC/M4A' },
];
function normalizeQualityPreference(value) {
  const raw = String(value || '').toLowerCase().trim();
  if (['jymaster', 'master', 'studio', 'svip'].includes(raw)) return 'jymaster';
  if (['hires', 'hi-res', 'highres', 'zhenyin', 'spatial'].includes(raw)) return 'hires';
  if (['lossless', 'flac', 'sq'].includes(raw)) return 'lossless';
  if (['exhigh', 'high', '320', '320k', 'hq'].includes(raw)) return 'exhigh';
  if (['standard', 'normal', '128', '128k', 'std'].includes(raw)) return 'standard';
  return 'hires';
}
function qualityCandidatesFrom(target, candidates) {
  target = normalizeQualityPreference(target);
  let start = candidates.findIndex(item => item.level === target);
  if (start < 0) start = 0;
  return candidates.slice(start);
}
function hasNeteaseSvip(loginInfo) {
  return !!(loginInfo && loginInfo.loggedIn && (loginInfo.vipLevel === 'svip' || loginInfo.isSvip || Number(loginInfo.vipType || 0) >= 10));
}
function mapArtists(raw) {
  return (raw || [])
    .map(a => ({ id: a && a.id, name: (a && a.name) || '' }))
    .filter(a => a.name);
}
function mapSongRecord(s) {
  s = s || {};
  const artists = mapArtists(s.ar || s.artists);
  const album = s.al || s.album || {};
  return {
    provider: 'netease',
    source: 'netease',
    type: 'song',
    id: s.id,
    name: s.name,
    artist: artists.map(a => a.name).join(' / '),
    artists,
    artistId: artists[0] && artists[0].id,
    album: album.name || '',
    cover: album.picUrl || album.coverUrl || '',
    duration: s.dt || s.duration || 0,
    fee: s.fee,
  };
}
function mapDiscoverPlaylist(pl, tag) {
  pl = pl || {};
  const creator = pl.creator || pl.user || {};
  const id = pl.id || pl.resourceId || pl.creativeId;
  return {
    provider: 'netease',
    source: 'netease',
    type: 'playlist',
    id,
    name: pl.name || pl.title || '',
    cover: pl.picUrl || pl.coverImgUrl || pl.coverUrl || pl.uiElement && pl.uiElement.image && pl.uiElement.image.imageUrl || '',
    trackCount: pl.trackCount || pl.songCount || pl.programCount || 0,
    playCount: pl.playCount || pl.playcount || 0,
    creator: creator.nickname || creator.name || '',
    tag: tag || pl.alg || '',
  };
}

function lowSignalText(value) {
  return String(value || '').trim().toLowerCase();
}

function isLowSignalPodcastItem(item) {
  const name = lowSignalText(item && (item.name || item.title || item.radioName));
  const sub = lowSignalText(item && (item.djName || item.category || item.desc || item.sub));
  const text = name + ' ' + sub;
  return /购买播客|付费精品|qzone|空间背景音乐|背景音乐|四只烤翅|试纸烤翅/i.test(text);
}

function isQQFavoritePlaylist(pl) {
  const name = String(pl && pl.name || '').trim();
  return /我喜欢|我的喜欢|喜欢的音乐/i.test(name);
}

function isQzoneBackgroundPlaylist(pl) {
  const text = String((pl && pl.name || '') + ' ' + (pl && pl.creator || '')).toLowerCase();
  return /qzone|空间|背景音乐/i.test(text);
}
async function requireLogin(res) {
  const info = await getLoginInfo();
  if (!info.loggedIn || !info.userId) {
    sendJSON(res, { error: 'LOGIN_REQUIRED', loggedIn: false }, 401);
    return null;
  }
  return info;
}

// ---------- 业务: 搜索 ----------
//   优先用 cloudsearch (新接口, 字段更全, picUrl 更稳定)
//   对于仍然缺失封面的歌曲, 用 song_detail 批量补齐
//   type: 1=单曲(默认), 10=专辑, 100=歌手, 1000=歌单, 1004=MV, 1009=电台
//   offset: 分页偏移
async function handleSearch(keywords, limit, type, offset) {
  console.log('[Search]', keywords, 'limit:', limit, 'type:', type || 1, 'offset:', offset || 0);
  const searchType = type || 1;
  const searchOffset = offset || 0;
  const result = await cloudsearch({ keywords, limit, type: searchType, offset: searchOffset, cookie: userCookie });
  const body = (result.body && result.body.result) || {};

  // 单曲类型走原有映射逻辑（含封面兜底）
  if (searchType === 1) {
    const songs = body.songs || [];
    let mapped = songs.map(s => mapSongRecord(s));

    // 兜底: 补齐缺失的封面
    const missing = mapped.filter(s => !s.cover).map(s => s.id);
    if (missing.length) {
      try {
        console.log('[Search] backfilling covers for', missing.length, 'songs');
        const dd = await song_detail({ ids: missing.join(','), cookie: userCookie });
        const songsArr = (dd.body && dd.body.songs) || [];
        const idToPic = {};
        songsArr.forEach(s => {
          const pic = (s.al && s.al.picUrl) || (s.album && s.album.picUrl) || '';
          if (pic) idToPic[s.id] = pic;
        });
        mapped = mapped.map(s => s.cover ? s : { ...s, cover: idToPic[s.id] || '' });
      } catch (e) { console.warn('[Search] backfill failed:', e.message); }
    }

    return mapped;
  }

  // 其他类型（专辑/歌单/MV/电台）按字段映射
  if (searchType === 10) {
    // 专辑
    return (body.albums || []).map(a => ({
      provider: 'netease', source: 'netease', type: 'album',
      id: a.id, name: a.name,
      artist: (a.artist && a.artist.name) || '',
      cover: a.picUrl || (a.img1v1Url) || '',
      publishTime: a.publishTime || 0,
      size: a.size || 0,
    }));
  }
  if (searchType === 1000) {
    // 歌单
    return (body.playlists || []).map(p => ({
      provider: 'netease', source: 'netease', type: 'playlist',
      id: p.id, name: p.name,
      cover: p.coverImgUrl || p.picUrl || '',
      creator: (p.creator && p.creator.nickname) || '',
      trackCount: p.trackCount || 0,
      playCount: p.playCount || 0,
    }));
  }
  if (searchType === 1004) {
    // MV
    return (body.mvs || []).map(m => ({
      provider: 'netease', source: 'netease', type: 'mv',
      id: m.id, name: m.name,
      artist: (m.artistName) || ((m.artists || []).map(a => a.name).join(' / ')),
      cover: m.cover || m.picUrl || '',
      duration: m.duration || 0,
      playCount: m.playCount || 0,
    }));
  }
  if (searchType === 1009) {
    // 电台
    return (body.djRadios || []).map(r => ({
      provider: 'netease', source: 'netease', type: 'djradio',
      id: r.id, name: r.name,
      djName: (r.dj && r.dj.nickname) || '',
      cover: r.picUrl || '',
      programCount: r.programCount || 0,
      subCount: r.subCount || 0,
    }));
  }
  return [];
}

async function handleDiscoverHome() {
  const info = await getLoginInfo();
  const loggedIn = !!(info && info.loggedIn);
  if (!loggedIn) {
    return {
      loggedIn: false,
      user: null,
      dailySongs: [],
      playlists: [],
      podcasts: [],
      mode: 'starter',
      updatedAt: Date.now(),
    };
  }
  const tasks = [
    personalized({ limit: 8, cookie: userCookie, timestamp: Date.now() }),
    dj_hot({ limit: 6, offset: 0, cookie: userCookie, timestamp: Date.now() }),
    recommend_resource({ cookie: userCookie, timestamp: Date.now() }),
    recommend_songs({ cookie: userCookie, timestamp: Date.now() }),
  ];
  const result = await Promise.allSettled(tasks);

  const personalizedBody = result[0].status === 'fulfilled' && result[0].value && result[0].value.body || {};
  const publicPlaylists = (personalizedBody.result || personalizedBody.data || [])
    .map(pl => mapDiscoverPlaylist(pl, '推荐歌单'))
    .filter(pl => pl.id && pl.name)
    .slice(0, 8);

  const podcastBody = result[1].status === 'fulfilled' && result[1].value && result[1].value.body || {};
  const podcastRaw = podcastBody.djRadios || podcastBody.djradios || podcastBody.radios || podcastBody.data || [];
  const podcasts = (Array.isArray(podcastRaw) ? podcastRaw : [])
    .map(mapPodcastRadio)
    .filter(p => p.id && !isLowSignalPodcastItem(p))
    .slice(0, 6);

  let privatePlaylists = [];
  if (result[2].status === 'fulfilled' && result[2].value) {
    const body = result[2].value.body || {};
    const raw = body.recommend || body.data || [];
    privatePlaylists = (Array.isArray(raw) ? raw : [])
      .map(pl => mapDiscoverPlaylist(pl, '私人推荐'))
      .filter(pl => pl.id && pl.name)
      .slice(0, 6);
  }

  let dailySongs = [];
  if (result[3].status === 'fulfilled' && result[3].value) {
    const body = result[3].value.body || {};
    const raw = body.data && (body.data.dailySongs || body.data.recommend) || body.recommend || [];
    dailySongs = (Array.isArray(raw) ? raw : [])
      .map(mapSongRecord)
      .filter(song => song.id && song.name)
      .slice(0, 12);
  }

  return {
    loggedIn,
    user: loggedIn ? { userId: info.userId, nickname: info.nickname || '', avatar: info.avatar || '' } : null,
    dailySongs,
    playlists: privatePlaylists.concat(publicPlaylists).slice(0, 10),
    podcasts,
    updatedAt: Date.now(),
  };
}

/**
 * 获取首页额外数据：排行榜、热门歌手、新歌速递（不依赖登录）
 */
async function handleDiscoverExtra() {
  const tasks = [
    toplist({ cookie: userCookie, timestamp: Date.now() }),
    top_artists({ limit: 12, cookie: userCookie, timestamp: Date.now() }),
    top_song({ type: 7, cookie: userCookie, timestamp: Date.now() }), // 7=新歌
  ];
  const result = await Promise.allSettled(tasks);

  let toplistData = [];
  if (result[0].status === 'fulfilled' && result[0].value) {
    const body = result[0].value.body || {};
    const list = body.list || [];
    toplistData = list.slice(0, 12).map(t => ({
      id: t.id,
      name: t.name || '',
      cover: t.coverImgUrl || t.coverUrl || '',
      description: t.description || '',
      trackCount: t.trackCount || t.track_count || 0,
      playCount: t.playCount || t.play_count || 0,
      tracks: (t.tracks || []).slice(0, 3).map(s => ({
        name: s.name || s.first || '',
        artist: (s.artists || s.artists_name || '').map(a => a.name || a).join(' / ') || s.second || ''
      }))
    }));
  }

  let topArtists = [];
  if (result[1].status === 'fulfilled' && result[1].value) {
    const body = result[1].value.body || {};
    const list = body.artists || [];
    topArtists = list.slice(0, 12).map(a => ({
      id: a.id,
      name: a.name || '',
      cover: a.picUrl || a.img1v1Url || '',
      albumSize: a.albumSize || 0,
      musicSize: a.musicSize || 0,
    }));
  }

  let newSongs = [];
  if (result[2].status === 'fulfilled' && result[2].value) {
    const body = result[2].value.body || {};
    const list = body.data || [];
    newSongs = (Array.isArray(list) ? list : [])
      .map(mapSongRecord)
      .filter(s => s.id && s.name)
      .slice(0, 12);
  }

  // 推荐歌单（仿 AlgerMusicPlayer）
  let recommendations = [];
  try {
    const pResult = await personalized({ limit: 10, cookie: userCookie, timestamp: Date.now() });
    if (pResult && pResult.body && pResult.body.result) {
      recommendations = pResult.body.result.slice(0, 10).map(t => ({
        id: t.id,
        name: t.name || '',
        cover: t.picUrl || t.coverImgUrl || '',
        trackCount: t.trackCount || 0,
        playCount: t.playCount || 0,
      }));
    }
  } catch (e) {
    console.warn('[DiscoverExtra] personalized failed:', e.message);
  }

  return { toplist: toplistData, topArtists, newSongs, recommendations };
}

const QQ_MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const QQ_SMARTBOX_URL = 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg';
const QQ_HEADERS = {
  Referer: 'https://y.qq.com/',
  'User-Agent': UA,
};

function requestText(targetUrl, opts, body) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode >= 400) {
          const err = new Error('HTTP ' + response.statusCode);
          err.statusCode = response.statusCode;
          err.body = text;
          reject(err);
          return;
        }
        resolve(text);
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function requestJson(targetUrl, opts, body) {
  const text = await requestText(targetUrl, opts, body);
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error('Invalid JSON from ' + targetUrl);
    err.cause = e;
    throw err;
  }
}

function clampNumber(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function openMeteoWeatherLabel(code) {
  code = Number(code);
  if (code === 0) return '晴';
  if (code === 1 || code === 2) return '少云';
  if (code === 3) return '阴';
  if (code === 45 || code === 48) return '雾';
  if (code === 51 || code === 53 || code === 55) return '毛毛雨';
  if (code === 56 || code === 57) return '冻雨';
  if (code === 61 || code === 63 || code === 65) return '雨';
  if (code === 66 || code === 67) return '冻雨';
  if (code === 71 || code === 73 || code === 75 || code === 77) return '雪';
  if (code === 80 || code === 81 || code === 82) return '阵雨';
  if (code === 85 || code === 86) return '阵雪';
  if (code === 95 || code === 96 || code === 99) return '雷雨';
  return '天气';
}

function buildWeatherMood(weather, date) {
  const now = date || new Date();
  const hour = now.getHours();
  const code = Number(weather && weather.weatherCode);
  const temp = Number(weather && weather.temperature);
  const apparent = Number(weather && weather.apparentTemperature);
  const rain = Number(weather && weather.precipitation) || 0;
  const humidity = Number(weather && weather.humidity) || 0;
  const wind = Number(weather && weather.windSpeed) || 0;
  const isNight = weather && weather.isDay === 0 || hour < 6 || hour >= 20;
  const isMorning = hour >= 5 && hour < 11;
  const isDusk = hour >= 17 && hour < 20;
  const isRain = rain > 0 || [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code);
  const isSnow = [71, 73, 75, 77, 85, 86].includes(code);
  const isCloud = [2, 3, 45, 48].includes(code);
  const isStorm = [95, 96, 99].includes(code);
  const feels = Number.isFinite(apparent) ? apparent : temp;

  let mood = {
    key: 'clear',
    title: '晴朗电台',
    tagline: '让节奏亮一点，像窗边的光',
    energy: 0.62,
    warmth: 0.58,
    focus: 0.48,
    melancholy: 0.24,
    keywords: ['轻快 华语', 'city pop', 'indie pop', 'chill pop', '阳光 歌单'],
  };
  if (isStorm) {
    mood = {
      key: 'storm',
      title: '雷雨电台',
      tagline: '低频更厚，适合把世界关小一点',
      energy: 0.46,
      warmth: 0.34,
      focus: 0.66,
      melancholy: 0.62,
      keywords: ['暗色 R&B', 'trip hop', '夜晚 电子', '氛围 摇滚', '雨夜 歌单'],
    };
  } else if (isRain) {
    mood = {
      key: 'rain',
      title: '雨天电台',
      tagline: '留一点潮湿的空间给旋律',
      energy: 0.38,
      warmth: 0.42,
      focus: 0.64,
      melancholy: 0.66,
      keywords: ['雨天 R&B', 'lofi rainy', '华语 慢歌', 'dream pop', '雨夜 歌单'],
    };
  } else if (isSnow || feels <= 3) {
    mood = {
      key: 'snow',
      title: '冷空气电台',
      tagline: '干净、慢速、带一点冬天的颗粒感',
      energy: 0.34,
      warmth: 0.28,
      focus: 0.72,
      melancholy: 0.54,
      keywords: ['冬天 民谣', 'ambient piano', '日系 冬天', 'indie folk', '安静 歌单'],
    };
  } else if (feels >= 31 || humidity >= 78) {
    mood = {
      key: 'humid',
      title: '闷热电台',
      tagline: '降低密度，留出一点呼吸',
      energy: 0.48,
      warmth: 0.76,
      focus: 0.46,
      melancholy: 0.30,
      keywords: ['夏日 chill', 'bossa nova', 'city pop 夏天', '轻电子', '海边 歌单'],
    };
  } else if (isCloud) {
    mood = {
      key: 'cloudy',
      title: '阴天电台',
      tagline: '不急着明亮，先让声音变软',
      energy: 0.40,
      warmth: 0.46,
      focus: 0.58,
      melancholy: 0.52,
      keywords: ['阴天 华语', 'indie rock mellow', 'neo soul', 'chillhop', '独立 民谣'],
    };
  }

  if (isNight) {
    mood.key += '-night';
    mood.title = mood.key.startsWith('clear') ? '夜色电台' : mood.title.replace('电台', '夜听');
    mood.tagline = '音量放低一点，让夜色参与编曲';
    mood.energy = Math.min(mood.energy, 0.42);
    mood.focus = Math.max(mood.focus, 0.68);
    mood.melancholy = Math.max(mood.melancholy, 0.52);
    mood.keywords = ['夜晚 R&B', 'late night jazz', 'ambient', 'lofi sleep', '夜跑 歌单'].concat(mood.keywords.slice(0, 3));
  } else if (isMorning) {
    mood.title = mood.key.startsWith('rain') ? '雨晨电台' : '早晨电台';
    mood.energy = Math.max(mood.energy, 0.52);
    mood.keywords = ['早晨 通勤', 'morning acoustic', '清晨 indie', '轻快 华语'].concat(mood.keywords.slice(0, 3));
  } else if (isDusk) {
    mood.title = mood.key.startsWith('rain') ? '黄昏雨声' : '黄昏电台';
    mood.melancholy = Math.max(mood.melancholy, 0.48);
    mood.keywords = ['黄昏 city pop', '日落 歌单', '落日飞车', 'soul pop'].concat(mood.keywords.slice(0, 3));
  }

  if (wind >= 28) {
    mood.energy = Math.max(mood.energy, 0.56);
    mood.keywords = ['公路 摇滚', 'windy day playlist'].concat(mood.keywords.slice(0, 4));
  }
  mood.keywords = Array.from(new Set(mood.keywords)).slice(0, 7);
  return mood;
}

async function resolveOpenMeteoLocation(query) {
  const raw = String(query || '').trim();
  if (!raw) return WEATHER_DEFAULT_LOCATION;
  const u = new URL(OPEN_METEO_GEOCODE_URL);
  u.searchParams.set('name', raw);
  u.searchParams.set('count', '1');
  u.searchParams.set('language', 'zh');
  u.searchParams.set('format', 'json');
  const body = await requestJson(u.toString(), { headers: { 'User-Agent': UA } });
  const first = body && Array.isArray(body.results) && body.results[0];
  if (!first) return { ...WEATHER_DEFAULT_LOCATION, query: raw, fallback: true };
  return {
    name: first.name || raw,
    country: first.country || '',
    admin1: first.admin1 || '',
    latitude: first.latitude,
    longitude: first.longitude,
    timezone: first.timezone || 'auto',
  };
}

async function fetchOpenMeteoWeather(params) {
  params = params || {};
  let location;
  const lat = clampNumber(params.lat, -90, 90, NaN);
  const lon = clampNumber(params.lon, -180, 180, NaN);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    location = {
      name: String(params.city || params.name || '当前位置').trim() || '当前位置',
      country: '',
      latitude: lat,
      longitude: lon,
      timezone: params.timezone || 'auto',
    };
  } else {
    location = await resolveOpenMeteoLocation(params.city || params.q || params.location);
  }
  const u = new URL(OPEN_METEO_FORECAST_URL);
  u.searchParams.set('latitude', String(location.latitude));
  u.searchParams.set('longitude', String(location.longitude));
  u.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m');
  u.searchParams.set('hourly', 'precipitation_probability,weather_code,temperature_2m');
  u.searchParams.set('forecast_days', '1');
  u.searchParams.set('timezone', location.timezone || 'auto');
  const body = await requestJson(u.toString(), { headers: { 'User-Agent': UA } });
  const cur = body && body.current || {};
  const weather = {
    provider: 'open-meteo',
    location: {
      name: location.name,
      country: location.country || '',
      admin1: location.admin1 || '',
      latitude: location.latitude,
      longitude: location.longitude,
      timezone: body.timezone || location.timezone || '',
      fallback: !!location.fallback,
    },
    label: openMeteoWeatherLabel(cur.weather_code),
    weatherCode: Number(cur.weather_code),
    temperature: Number(cur.temperature_2m),
    apparentTemperature: Number(cur.apparent_temperature),
    humidity: Number(cur.relative_humidity_2m),
    precipitation: Number(cur.precipitation || cur.rain || cur.showers || cur.snowfall || 0),
    cloudCover: Number(cur.cloud_cover),
    windSpeed: Number(cur.wind_speed_10m),
    windGusts: Number(cur.wind_gusts_10m),
    isDay: Number(cur.is_day),
    time: cur.time || '',
    updatedAt: Date.now(),
  };
  weather.mood = buildWeatherMood(weather);
  return weather;
}

async function fetchIpWeatherLocation() {
  const u = new URL(WEATHER_IP_LOCATION_URL);
  u.searchParams.set('fields', 'status,message,country,regionName,city,lat,lon,timezone,query');
  u.searchParams.set('lang', 'zh-CN');
  const body = await requestJson(u.toString(), { headers: { 'User-Agent': UA } });
  if (!body || body.status !== 'success' || !Number.isFinite(Number(body.lat)) || !Number.isFinite(Number(body.lon))) {
    const err = new Error(body && body.message || 'IP_LOCATION_FAILED');
    err.body = body;
    throw err;
  }
  return {
    provider: 'ip-api',
    city: body.city || WEATHER_DEFAULT_LOCATION.name,
    region: body.regionName || '',
    country: body.country || '',
    latitude: Number(body.lat),
    longitude: Number(body.lon),
    timezone: body.timezone || 'auto',
    ip: body.query || '',
  };
}

function weatherRadioSeedQueries(mood) {
  const key = String(mood && mood.key || '');
  if (key.includes('rain') || key.includes('storm')) return ['陈奕迅 阴天快乐', '周杰伦 雨下一整晚', '孙燕姿 遇见', '林宥嘉 说谎', '毛不易 消愁'];
  if (key.includes('snow') || key.includes('cloudy')) return ['陈奕迅 好久不见', '莫文蔚 阴天', '李健 贝加尔湖畔', '朴树 平凡之路', '蔡健雅 达尔文'];
  if (key.includes('humid')) return ['落日飞车 My Jinji', '告五人 爱人错过', '夏日入侵企画 想去海边', '陈绮贞 旅行的意义', '王若琳 Lost in Paradise'];
  if (key.includes('night')) return ['方大同 特别的人', '陶喆 爱很简单', 'Frank Ocean Pink + White', '林忆莲 夜太黑', "Norah Jones Don't Know Why"];
  return ['孙燕姿 天黑黑', '周杰伦 晴天', '五月天 温柔', '陈奕迅 稳稳的幸福', '王菲'];
}

function fallbackWeatherForRadio(params, err) {
  params = params || {};
  const name = String(params.city || params.q || params.location || WEATHER_DEFAULT_LOCATION.name).trim() || WEATHER_DEFAULT_LOCATION.name;
  return {
    provider: 'open-meteo',
    location: {
      name,
      country: '',
      admin1: '',
      latitude: null,
      longitude: null,
      timezone: params.timezone || WEATHER_DEFAULT_LOCATION.timezone,
      fallback: true,
    },
    label: '天气暂不可用',
    weatherCode: null,
    temperature: null,
    apparentTemperature: null,
    humidity: null,
    precipitation: null,
    cloudCover: null,
    windSpeed: null,
    windGusts: null,
    isDay: null,
    time: '',
    updatedAt: Date.now(),
    error: err && err.message || '',
    mood: {
      key: 'fallback',
      title: '临时电台',
      tagline: '天气暂时没有回来，先放一组稳妥的歌',
      energy: 0.54,
      warmth: 0.55,
      focus: 0.55,
      melancholy: 0.35,
      keywords: ['华语 流行', 'indie pop', 'city pop', '轻快 歌单', 'chill pop'],
    },
  };
}

function uniqueSongsByKey(songs) {
  const seen = new Set();
  const out = [];
  (songs || []).forEach(song => {
    const key = String(song && (song.id || song.name + '|' + song.artist) || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(song);
  });
  return out;
}

function tagWeatherPoolSongs(songs, source) {
  return (songs || []).map(song => ({ ...song, weatherSource: source }));
}

async function fetchWeatherPlaylistSongs(playlist, limit) {
  const id = playlist && playlist.id;
  if (!id) return [];
  let rawTracks = [];
  try {
    if (typeof playlist_track_all === 'function') {
      const all = await playlist_track_all({ id, limit: limit || 36, offset: 0, cookie: userCookie, timestamp: Date.now() });
      rawTracks = (all.body && (all.body.songs || all.body.tracks)) || [];
    }
  } catch (e) {
    console.warn('[WeatherRadio] playlist_track_all failed:', playlist && playlist.name, e.message);
  }
  if (!rawTracks.length && typeof playlist_detail === 'function') {
    try {
      const detail = await playlist_detail({ id, s: 0, cookie: userCookie, timestamp: Date.now() });
      const pl = (detail.body && detail.body.playlist) || {};
      rawTracks = pl.tracks || [];
    } catch (e) {
      console.warn('[WeatherRadio] playlist_detail failed:', playlist && playlist.name, e.message);
    }
  }
  return rawTracks.map(mapSongRecord).filter(song => song.id && song.name).slice(0, limit || 36);
}

async function filterLikelyPlayableWeatherSongs(songs) {
  const source = uniqueSongsByKey(songs)
    .filter(song => song && song.name && song.id && !isLowSignalWeatherSong(song))
    .slice(0, 24);
  const playable = [];
  const fallback = source.slice(0, 24);
  for (let i = 0; i < source.length; i += 4) {
    const chunk = source.slice(i, i + 4);
    const settled = await Promise.allSettled(chunk.map(async song => {
      const info = await handleSongUrl(song.id, { loggedIn: !!userCookie }, 'standard');
      return info && info.url ? song : null;
    }));
    settled.forEach((result, idx) => {
      if (result.status === 'fulfilled' && result.value) playable.push(result.value);
      else if (result.status === 'rejected') console.warn('[WeatherRadio] playable probe failed:', chunk[idx] && chunk[idx].name, result.reason && result.reason.message);
    });
    if (playable.length >= 12) break;
  }
  return (playable.length ? playable : fallback).slice(0, 24);
}

function isLowSignalWeatherSong(song) {
  const text = String([
    song && song.name,
    song && song.artist,
    song && song.album,
  ].filter(Boolean).join(' ')).toLowerCase();
  if (!text) return true;
  if (/(^|[\s\-_/（(])ai(?:\s*(歌|歌曲|音乐|cover|翻唱|生成|作曲|演唱|女声|男声)|$|[\s\-_/）)])/i.test(text)) return true;
  if (/suno|udio|人工智能|生成歌曲|ai歌曲|虚拟歌手|测试音频|demo|beat\s*maker/i.test(text)) return true;
  if (/翻自|翻唱|cover|remix|伴奏|纯音乐|钢琴|dj|live\s*版|live版|唯美钢琴|karaoke|instrumental/i.test(text)) return true;
  if (/白噪音|雨声|睡眠|助眠|冥想|疗愈频率|环境音|自然声音|asmr/i.test(text)) return true;
  if (/[（(](r&b|lofi|jazz|dj|edm|trap|remix|伴奏|纯音乐|钢琴|电子|治愈|古风|女声|男声|英文|中文版|抖音|ai)[）)]/i.test(text)) return true;
  if (/^(纯音乐|轻音乐|治愈系|放松|睡眠|雨天|阴天|夜晚|夏日|海边)$/i.test(String(song.name || '').trim())) return true;
  return false;
}

function scoreWeatherSong(song, mood) {
  const text = String((song && song.name || '') + ' ' + (song && song.artist || '') + ' ' + (song && song.album || '')).toLowerCase();
  let score = 0;
  if (song && song.cover) score += 4;
  if (song && song.duration) score += 2;
  if (song && song.weatherSource === 'daily') score += 6;
  if (song && song.weatherSource === 'private') score += 4;
  if (/周杰伦|陈奕迅|孙燕姿|五月天|王菲|陶喆|方大同|林宥嘉|蔡健雅|莫文蔚|李健|毛不易|告五人|落日飞车|陈绮贞|朴树/.test(text)) score += 10;
  const key = String(mood && mood.key || '');
  if (key.includes('rain') && /雨|阴|夜|慢|r&b|soul|陈奕迅|林宥嘉|孙燕姿/.test(text)) score += 5;
  if (key.includes('humid') && /夏|海|city|pop|落日|告五人|方大同|陶喆/.test(text)) score += 5;
  if (key.includes('night') && /夜|moon|jazz|soul|r&b|方大同|陶喆|王菲/.test(text)) score += 5;
  if (key.includes('cloudy') && /阴|民谣|indie|陈绮贞|朴树|李健/.test(text)) score += 5;
  return score;
}

function weatherArtistKey(song) {
  const raw = String(song && song.artist || song && song.name || '').split(/\s*\/\s*|、|,|&/)[0] || '';
  return raw.trim().toLowerCase() || 'unknown';
}

function weatherTitleKey(song) {
  return String(song && song.name || '')
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s._\-·'’"“”「」《》:：/\\|]+/g, '')
    .trim();
}

function uniqueWeatherTitles(sorted) {
  const seen = new Set();
  const out = [];
  (sorted || []).forEach(song => {
    const key = weatherTitleKey(song);
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    out.push(song);
  });
  return out;
}

function diversifyWeatherSongs(sorted, artistLimit) {
  const primary = [];
  const deferred = [];
  const counts = new Map();
  (sorted || []).forEach(song => {
    const key = weatherArtistKey(song);
    const count = counts.get(key) || 0;
    if (count < artistLimit) {
      primary.push(song);
      counts.set(key, count + 1);
    } else {
      deferred.push(song);
    }
  });
  return primary.length >= 8 ? primary : primary.concat(deferred.slice(0, 8 - primary.length));
}

function orderWeatherSongs(songs, mood) {
  const sorted = uniqueSongsByKey(songs)
    .filter(song => song && song.name && song.id && !isLowSignalWeatherSong(song))
    .sort((a, b) => scoreWeatherSong(b, mood) - scoreWeatherSong(a, mood));
  return diversifyWeatherSongs(uniqueWeatherTitles(sorted), 2);
}

async function buildWeatherRadio(params) {
  let weather;
  try {
    weather = await fetchOpenMeteoWeather(params);
  } catch (e) {
    console.warn('[WeatherRadio] weather provider failed, using fallback radio:', e.message);
    weather = fallbackWeatherForRadio(params, e);
  }
  const queries = weatherRadioSeedQueries(weather.mood);
  let songs = [];
  const settled = await Promise.allSettled(queries.slice(0, 4).map(q => handleSearch(q, 6)));
  settled.forEach(result => {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) songs = songs.concat(result.value);
  });
  if (songs.length < 10 && weather.mood && Array.isArray(weather.mood.keywords)) {
    const more = await Promise.allSettled(weather.mood.keywords.slice(0, 2).map(q => handleSearch(q, 6)));
    more.forEach(result => {
      if (result.status === 'fulfilled' && Array.isArray(result.value)) songs = songs.concat(result.value);
    });
  }
  songs = orderWeatherSongs(songs, weather.mood);
  return {
    ok: true,
    weather,
    radio: {
      title: weather.mood.title,
      subtitle: weather.mood.tagline,
      seedQueries: queries.slice(0, 4),
      songs: songs.slice(0, 18),
      updatedAt: Date.now(),
    },
  };
}

function parseJSONText(text) {
  const raw = String(text || '').trim();
  const json = raw.replace(/^callback\(([\s\S]*)\);?$/, '$1');
  return JSON.parse(json);
}

async function qqMusicRequest(payload, opts) {
  opts = opts || {};
  const body = JSON.stringify(payload);
  const headers = {
    ...QQ_HEADERS,
    'Content-Type': 'application/json;charset=UTF-8',
    'Content-Length': Buffer.byteLength(body),
  };
  if (opts.cookie && qqCookie) headers.Cookie = qqCookie;
  const text = await requestText(QQ_MUSICU_URL, {
    method: 'POST',
    headers,
  }, body);
  return parseJSONText(text);
}

function normalizeQQProfile(body, cookieObj) {
  cookieObj = cookieObj || qqCookieObject();
  const uin = qqCookieUin(cookieObj);
  const data = (body && (body.data || body.profile || body.creator || body.result)) || {};
  const creator = (data.creator || data.user || data.profile || data) || {};
  const vipInfo = data.vipInfo || data.vipinfo || data.vip || creator.vipInfo || creator.vipinfo || {};
  const profileNick = creator.nick || creator.nickname || creator.name || creator.hostname || creator.title || '';
  const profileAvatar = creator.headpic || creator.avatar || creator.avatarUrl || creator.logo || '';
  const cookieNick = qqCookieNickname(cookieObj, uin);
  const nick = profileNick || cookieNick || '';
  const avatar = profileAvatar || qqCookieAvatar(cookieObj, uin);
  let vipType = Number(
    cookieObj.vipType || cookieObj.vip_type ||
    data.vipType || data.vip_type || data.viptype || data.music_vip_level || data.green_vip_level || data.luxury_vip_level ||
    creator.vipType || creator.vip_type || creator.music_vip_level || creator.green_vip_level || creator.luxury_vip_level ||
    vipInfo.vipType || vipInfo.vip_type || vipInfo.music_vip_level || vipInfo.green_vip_level || vipInfo.luxury_vip_level || 0
  ) || 0;
  if (!vipType) {
    const vipFlag = data.isVip || data.is_vip || data.vipFlag || data.vipflag || creator.isVip || creator.is_vip || vipInfo.isVip || vipInfo.is_vip || vipInfo.vipFlag;
    if (vipFlag === true || Number(vipFlag) > 0 || String(vipFlag || '').toLowerCase() === 'true') vipType = 1;
  }
  return {
    provider: 'qq',
    loggedIn: !!(uin && qqCookieMusicKey(cookieObj)),
    preview: false,
    userId: uin,
    nickname: nick || (uin ? ('QQ ' + uin) : 'QQ 音乐'),
    avatar,
    vipType,
    hasCookie: !!qqCookie,
    playbackKeyReady: !!qqCookiePlaybackKey(cookieObj),
    profileSource: profileNick || profileAvatar ? 'qq-profile' : (cookieNick || avatar ? 'cookie' : 'fallback'),
  };
}

async function getQQLoginInfo() {
  const cookieObj = qqCookieObject();
  const uin = qqCookieUin(cookieObj);
  const musicKey = qqCookieMusicKey(cookieObj);
  if (!uin || !musicKey) return { provider: 'qq', loggedIn: false, hasCookie: !!qqCookie };
  const fallback = normalizeQQProfile(null, cookieObj);
  try {
    const u = new URL('https://c.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg');
    u.searchParams.set('cid', '205360838');
    u.searchParams.set('userid', uin);
    u.searchParams.set('reqfrom', '1');
    u.searchParams.set('g_tk', '5381');
    u.searchParams.set('loginUin', uin);
    u.searchParams.set('hostUin', '0');
    u.searchParams.set('format', 'json');
    u.searchParams.set('inCharset', 'utf8');
    u.searchParams.set('outCharset', 'utf-8');
    u.searchParams.set('notice', '0');
    u.searchParams.set('platform', 'yqq.json');
    u.searchParams.set('needNewCode', '0');
    const text = await requestText(u.toString(), {
      headers: { ...QQ_HEADERS, Cookie: qqCookie },
    });
    const body = parseJSONText(text);
    const info = normalizeQQProfile(body, cookieObj);
    if (body && (body.code === 1000 || body.result === 301)) {
      return { ...fallback, profileUnavailable: true };
    }
    return info;
  } catch (e) {
    console.warn('[QQLogin] profile check failed:', e.message);
    return { ...fallback, profileUnavailable: true };
  }
}

async function qqGetJSON(targetUrl, params, opts) {
  opts = opts || {};
  const u = new URL(targetUrl);
  Object.keys(params || {}).forEach(k => {
    if (params[k] != null) u.searchParams.set(k, String(params[k]));
  });
  const headers = { ...QQ_HEADERS, ...(opts.headers || {}) };
  if (opts.cookie !== false && qqCookie) headers.Cookie = qqCookie;
  const text = await requestText(u.toString(), { headers });
  return parseJSONText(text);
}

function audioProxyHeadersFor(audioUrl, range) {
  const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' };
  try {
    const host = new URL(audioUrl).hostname.toLowerCase();
    if (host.includes('qq.com') || host.includes('qpic.cn')) headers.Referer = 'https://y.qq.com/';
  } catch (e) {}
  if (range) headers.Range = range;
  return headers;
}

function audioContentTypeForUrl(audioUrl, upstreamType) {
  let pathname = '';
  try { pathname = new URL(audioUrl).pathname.toLowerCase(); } catch (e) {}
  if (/\.flac$/.test(pathname)) return 'audio/flac';
  if (/\.mp3$/.test(pathname)) return 'audio/mpeg';
  if (/\.(m4a|mp4)$/.test(pathname)) return 'audio/mp4';
  if (/\.ogg$/.test(pathname)) return 'audio/ogg';
  if (/\.wav$/.test(pathname)) return 'audio/wav';
  return upstreamType || 'audio/mpeg';
}

function mapQQPlaylist(pl, kind) {
  pl = pl || {};
  const id = pl.dissid || pl.tid || pl.dirid || pl.id || pl.diss_id;
  return {
    provider: 'qq',
    source: 'qq',
    id: id ? String(id) : '',
    name: pl.diss_name || pl.name || pl.title || '',
    cover: pl.diss_cover || pl.logo || pl.picurl || pl.cover || '',
    trackCount: pl.song_cnt || pl.songnum || pl.total_song_num || pl.song_count || 0,
    playCount: pl.listen_num || pl.visitnum || pl.play_count || 0,
    creator: pl.hostname || pl.nick || pl.creator || 'QQ 音乐',
    subscribed: kind === 'collect',
    specialType: 0,
  };
}

function mapQQPlaylistTrack(raw) {
  raw = raw || {};
  const track = raw.songid || raw.songmid || raw.mid || raw.name ? raw : (raw.track_info || raw.songInfo || raw.songinfo || raw.song || {});
  const album = track.album || {};
  const artists = mapQQArtists(track.singer || track.singers || []);
  const mid = track.mid || track.songmid || raw.mid || raw.songmid || '';
  const albumMid = album.mid || track.albummid || raw.albummid || '';
  return {
    provider: 'qq',
    source: 'qq',
    type: 'qq',
    id: mid || String(track.id || track.songid || raw.id || raw.songid || ''),
    qqId: track.id || track.songid || raw.id || raw.songid || '',
    mid,
    songmid: mid,
    mediaMid: (track.file && track.file.media_mid) || track.strMediaMid || track.media_mid || raw.strMediaMid || '',
    name: track.name || track.songname || raw.songname || '',
    artist: artists.map(a => a.name).join(' / ') || track.singername || raw.singername || '',
    artists,
    artistId: artists[0] && (artists[0].id || artists[0].mid),
    artistMid: artists[0] && artists[0].mid,
    album: album.name || album.title || track.albumname || raw.albumname || '',
    albumMid,
    cover: qqAlbumCover(albumMid, 300),
    duration: (Number(track.interval || raw.interval) || 0) * 1000,
    fee: track.pay && Number(track.pay.pay_play) ? 1 : 0,
    playable: false,
  };
}

async function handleQQUserPlaylists() {
  const info = await getQQLoginInfo();
  if (!info.loggedIn || !info.userId) return { loggedIn: false, provider: 'qq', playlists: [] };
  const uin = info.userId;
  const createdReq = qqGetJSON('https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss', {
    hostUin: 0,
    hostuin: uin,
    sin: 0,
    size: 200,
    g_tk: 5381,
    loginUin: uin,
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: 0,
    platform: 'yqq.json',
    needNewCode: 0,
  }, { headers: { Referer: 'https://y.qq.com/portal/profile.html' } });
  const collectReq = qqGetJSON('https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg', {
    ct: 20,
    cid: 205360956,
    userid: uin,
    reqtype: 3,
    sin: 0,
    ein: 80,
  }, { headers: { Referer: 'https://y.qq.com/portal/profile.html' } });
  const [createdRaw, collectRaw] = await Promise.allSettled([createdReq, collectReq]);
  const created = createdRaw.status === 'fulfilled' && createdRaw.value && createdRaw.value.data && Array.isArray(createdRaw.value.data.disslist)
    ? createdRaw.value.data.disslist.map(pl => mapQQPlaylist(pl, 'created')) : [];
  const collected = collectRaw.status === 'fulfilled' && collectRaw.value && collectRaw.value.data && Array.isArray(collectRaw.value.data.cdlist)
    ? collectRaw.value.data.cdlist.map(pl => mapQQPlaylist(pl, 'collect')) : [];
  const seen = new Set();
  const playlists = created.concat(collected).filter(pl => {
    if (!pl.id || !pl.name || seen.has(pl.id)) return false;
    if (isQzoneBackgroundPlaylist(pl)) return false;
    seen.add(pl.id);
    return true;
  }).sort((a, b) => Number(isQQFavoritePlaylist(b)) - Number(isQQFavoritePlaylist(a)));
  return { loggedIn: true, provider: 'qq', userId: uin, playlists };
}

async function handleQQPlaylistTracks(id) {
  const info = await getQQLoginInfo();
  if (!info.loggedIn || !info.userId) return { loggedIn: false, provider: 'qq', tracks: [] };
  const pid = String(id || '').trim();
  if (!pid) return { loggedIn: true, provider: 'qq', error: 'Missing QQ playlist id', tracks: [] };
  const result = await qqGetJSON('https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg', {
    type: 1,
    utf8: 1,
    disstid: pid,
    loginUin: info.userId,
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: 0,
    platform: 'yqq.json',
    needNewCode: 0,
  }, { headers: { Referer: 'https://y.qq.com/n/yqq/playlist' } });
  const detail = result && result.cdlist && result.cdlist[0] ? result.cdlist[0] : {};
  const rawTracks = Array.isArray(detail.songlist) ? detail.songlist : [];
  const tracks = rawTracks.map(mapQQPlaylistTrack).filter(s => s.name && (s.mid || s.id));
  const playlist = {
    provider: 'qq',
    id: pid,
    name: detail.dissname || detail.diss_name || detail.name || '',
    cover: detail.logo || detail.diss_cover || '',
    trackCount: tracks.length,
  };
  return { loggedIn: true, provider: 'qq', playlist, tracks };
}

function qqAlbumCover(albumMid, size) {
  if (!albumMid) return '';
  const px = size || 300;
  return 'https://y.qq.com/music/photo_new/T002R' + px + 'x' + px + 'M000' + albumMid + '.jpg?max_age=2592000';
}

function qqSingerAvatar(singerMid, size) {
  if (!singerMid) return '';
  const px = size || 300;
  return 'https://y.qq.com/music/photo_new/T001R' + px + 'x' + px + 'M000' + singerMid + '.jpg?max_age=2592000';
}

function mapQQArtists(raw) {
  return (raw || [])
    .map(a => ({
      id: a && a.id,
      mid: a && a.mid,
      name: (a && (a.name || a.title)) || '',
    }))
    .filter(a => a.name);
}

function mapQQSmartSong(item) {
  item = item || {};
  const mid = item.mid || item.songmid || item.id || '';
  return {
    provider: 'qq',
    source: 'qq',
    type: 'qq',
    id: mid,
    qqId: item.id || item.docid || '',
    mid,
    songmid: mid,
    name: item.name || item.title || '',
    artist: item.singer || '',
    artists: item.singer ? [{ name: item.singer }] : [],
    album: '',
    cover: '',
    duration: 0,
    fee: 0,
    playable: false,
  };
}

function mapQQTrack(track, fallback) {
  track = track || {};
  fallback = fallback || {};
  const album = track.album || {};
  const artists = mapQQArtists(track.singer || []);
  const mid = track.mid || fallback.mid || fallback.songmid || '';
  const albumMid = album.mid || album.pmid || '';
  return {
    provider: 'qq',
    source: 'qq',
    type: 'qq',
    id: mid,
    qqId: track.id || fallback.qqId || fallback.id || '',
    mid,
    songmid: mid,
    mediaMid: track.file && track.file.media_mid,
    name: track.name || track.title || fallback.name || '',
    artist: artists.map(a => a.name).join(' / ') || fallback.artist || '',
    artists: artists.length ? artists : (fallback.artists || []),
    artistId: artists[0] && (artists[0].id || artists[0].mid),
    artistMid: artists[0] && artists[0].mid,
    album: album.name || album.title || fallback.album || '',
    albumMid,
    cover: qqAlbumCover(albumMid, 300) || fallback.cover || '',
    duration: (Number(track.interval) || 0) * 1000,
    fee: track.pay && Number(track.pay.pay_play) ? 1 : 0,
    playable: false,
  };
}

async function qqSmartboxSearch(keywords, limit) {
  const u = new URL(QQ_SMARTBOX_URL);
  u.searchParams.set('format', 'json');
  u.searchParams.set('key', keywords);
  u.searchParams.set('g_tk', '5381');
  u.searchParams.set('loginUin', '0');
  u.searchParams.set('hostUin', '0');
  u.searchParams.set('inCharset', 'utf8');
  u.searchParams.set('outCharset', 'utf-8');
  u.searchParams.set('notice', '0');
  u.searchParams.set('platform', 'yqq.json');
  u.searchParams.set('needNewCode', '0');
  const text = await requestText(u.toString(), { headers: QQ_HEADERS });
  const json = parseJSONText(text);
  const items = json && json.data && json.data.song && json.data.song.itemlist;
  return (Array.isArray(items) ? items : []).slice(0, Math.max(1, Math.min(limit || 6, 10))).map(mapQQSmartSong);
}

async function qqSongDetail(mid, fallback) {
  if (!mid) return fallback;
  const json = await qqMusicRequest({
    comm: { ct: 24, cv: 0 },
    songinfo: {
      module: 'music.pf_song_detail_svr',
      method: 'get_song_detail_yqq',
      param: { song_mid: mid },
    },
  });
  const data = json && json.songinfo && json.songinfo.data;
  return mapQQTrack(data && data.track_info, fallback);
}

async function handleQQArtistDetail(mid, limit) {
  const singerMid = String(mid || '').trim();
  const num = Math.max(10, Math.min(80, parseInt(limit || '36', 10) || 36));
  if (!singerMid) return { provider: 'qq', error: 'MISSING_SINGER_MID', artist: null, songs: [] };
  const json = await qqMusicRequest({
    comm: { ct: 24, cv: 0 },
    singer: {
      module: 'music.web_singer_info_svr',
      method: 'get_singer_detail_info',
      param: { sort: 5, singermid: singerMid, sin: 0, num },
    },
  }, { cookie: true });
  const block = json && json.singer;
  if (!block || Number(block.code || 0) !== 0) {
    return { provider: 'qq', error: block && (block.message || block.msg || block.code) || 'QQ_ARTIST_DETAIL_FAILED', artist: null, songs: [] };
  }
  const data = block.data || {};
  const info = data.singer_info || data.singerInfo || {};
  const rawSongs = Array.isArray(data.songlist) ? data.songlist : [];
  const songs = rawSongs
    .map(raw => mapQQTrack(raw && (raw.track_info || raw.songInfo || raw.songinfo || raw.song) || raw, {}))
    .filter(song => song && song.name && (song.mid || song.id));
  const matchedSongArtist = songs[0] && (songs[0].artists || []).find(a => a && a.mid === singerMid);
  const artistMid = info.mid || singerMid;
  const artistName = info.name || info.title || (matchedSongArtist && matchedSongArtist.name) || '';
  const totalSong = Number(data.total_song || data.song_count || 0) || songs.length;
  return {
    provider: 'qq',
    artist: {
      provider: 'qq',
      id: info.id || '',
      mid: artistMid,
      name: artistName,
      avatar: info.pic || info.avatar || qqSingerAvatar(artistMid, 300),
      fans: Number(info.fans || 0) || 0,
      musicSize: totalSong,
      albumSize: Number(data.total_album || 0) || 0,
      mvSize: Number(data.total_mv || 0) || 0,
    },
    total: totalSong,
    songs,
  };
}

async function handleQQSearch(keywords, limit) {
  const kw = String(keywords || '').trim();
  if (!kw) return [];
  console.log('[QQSearch]', kw, 'limit:', limit);
  const base = await qqSmartboxSearch(kw, limit);
  const detailed = await Promise.all(base.map(async item => {
    try { return await qqSongDetail(item.mid, item); }
    catch (e) {
      console.warn('[QQSearch] detail failed:', item.mid, e.message);
      return item;
    }
  }));
  const seen = new Set();
  return detailed.filter(song => {
    const key = song && (song.mid || song.id || (song.name + '|' + song.artist));
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return !!song.name;
  });
}

// ========== 酷狗音乐搜索 ==========
// 使用 songsearch.kugou.com/song_search_v2 接口（mobilecdn 在国内 Node fetch 下不可用）
async function handleKugouSearch(keywords, limit, offset) {
  const kw = String(keywords || '').trim();
  if (!kw) return [];
  const page = Math.floor((offset || 0) / 20) + 1;
  const pagesize = Math.min(30, limit || 20);
  console.log('[KugouSearch]', kw, 'page:', page, 'pagesize:', pagesize);
  try {
    const apiUrl = `https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(kw)}&page=${page}&pagesize=${pagesize}&platform=WebFilter&userid=-1&clientver=&iscorrection=1&privilege_filter=0&token=&srcappid=2919&clienttime=0&mid=0&uuid=0&dfid=0`;
    const resp = await fetch(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', 'Referer': 'https://www.kugou.com/' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) { console.warn('[KugouSearch] HTTP', resp.status); return []; }
    const json = await resp.json();
    const list = (json && json.data && Array.isArray(json.data.lists)) ? json.data.lists : [];
    const seen = new Set();
    return list.filter(item => item && item.FileHash && !seen.has(item.FileHash) && (seen.add(item.FileHash), true)).map(item => ({
      provider: 'kugou',
      source: 'kugou',
      type: 'song',
      id: item.FileHash,
      hash: item.FileHash,
      // 多音质 hash：标准128k / 极高320k / 无损FLAC / 无损高码率
      hqHash: item.HQFileHash || '',
      sqHash: item.SQFileHash || '',
      resHash: item.ResFileHash || '',
      albumId: item.AlbumID || '',
      name: String(item.SongName || item.FileName || '').replace(/<\/?em>/g, ''),
      artist: String(item.SingerName || '').replace(/<\/?em>/g, '') || '未知歌手',
      album: String(item.AlbumName || '').replace(/<\/?em>/g, ''),
      cover: item.Image ? String(item.Image).replace('{size}', '240') : '',
      duration: parseInt(item.Duration) || 0,
      // PayType: 0=免费, 3=付费
      fee: item.PayType === 3 ? 1 : 0,
      payType: item.PayType,
      playable: item.PayType !== 3,
    }));
  } catch (err) {
    console.error('[KugouSearch] error:', err.message);
    return [];
  }
}

// 酷狗播放URL获取（通过 hash）
// 不同音质 hash 不同：128k=FileHash, 320k=HQFileHash, FLAC=SQFileHash, Hi-Res=ResFileHash
async function handleKugouSongUrl(hash) {
  const h = String(hash || '').trim();
  if (!h) return { provider: 'kugou', url: '', error: 'MISSING_HASH', playable: false };
  console.log('[KugouSongUrl] hash:', h);
  try {
    const apiUrl = `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${h}`;
    const resp = await fetch(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36', 'Referer': 'http://m.kugou.com/' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return { provider: 'kugou', url: '', error: 'HTTP_' + resp.status, playable: false };
    const json = await resp.json();
    const url = json && json.url;
    if (url) {
      const br = parseInt(json.bitRate) || 128;
      const level = br >= 640 ? 'lossless' : (br >= 320 ? 'exhigh' : (br >= 192 ? 'higher' : 'standard'));
      return {
        provider: 'kugou',
        url,
        playable: true,
        trial: false,
        level,
        br: br * 1000,
        platform: 'kugou',
      };
    }
    // url 为空：通常是付费歌曲
    const err = (json && json.error) ? json.error : 'NO_URL';
    return { provider: 'kugou', url: '', error: err, playable: false };
  } catch (err) {
    console.error('[KugouSongUrl] error:', err.message);
    return { provider: 'kugou', url: '', error: err.message, playable: false };
  }
}

// ========== 酷我音乐搜索 ==========
// 使用 search.kuwo.cn/r.s 旧接口（无需 csrf token，返回单引号 JSON）
async function handleKuwoSearch(keywords, limit, offset) {
  const kw = String(keywords || '').trim();
  if (!kw) return [];
  const pn = Math.floor((offset || 0) / 20);
  const rn = Math.min(30, limit || 20);
  console.log('[KuwoSearch]', kw, 'pn:', pn, 'rn:', rn);
  try {
    const apiUrl = `http://search.kuwo.cn/r.s?all=${encodeURIComponent(kw)}&ft=music&itemset=web_2013&client=kt&pn=${pn}&rn=${rn}&rformat=json&encoding=utf8`;
    const resp = await fetch(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'http://www.kuwo.cn/' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) { console.warn('[KuwoSearch] HTTP', resp.status); return []; }
    // 旧接口返回单引号 JSON，需转双引号
    const txt = await resp.text();
    const safe = txt.replace(/'/g, '"').replace(/&nbsp;/g, ' ');
    let json;
    try { json = JSON.parse(safe); } catch (e) { console.warn('[KuwoSearch] JSON parse failed'); return []; }
    const list = (json && Array.isArray(json.abslist)) ? json.abslist : [];
    const seen = new Set();
    return list.filter(item => {
      const rid = item.DC_TARGETID || item.MUSICID;
      return rid && !seen.has(rid) && (seen.add(rid), true);
    }).map(item => {
      const rid = item.DC_TARGETID || item.MUSICID;
      const webName = (item.SONGNAME || item.NAME || '').replace(/&nbsp;/g, ' ').trim();
      const artist = (item.ARTIST || '').replace(/&nbsp;/g, ' ').trim();
      return {
        provider: 'kuwo',
        source: 'kuwo',
        type: 'song',
        id: rid,
        rid: rid,
        name: webName,
        artist: artist || '未知歌手',
        album: (item.ALBUM || '').replace(/&nbsp;/g, ' ').trim(),
        cover: '', // 旧接口无封面
        duration: parseInt(item.DURATION) || 0,
        // FORMATS: 'AAC48|MP3128|MP3320|FLAC|...' 有FLAC为无损
        formats: item.FORMATS || '',
        fee: 0,
        playable: true,
      };
    });
  } catch (err) {
    console.error('[KuwoSearch] error:', err.message);
    return [];
  }
}

// 酷我播放URL：antiserver.kuwo.cn 旧接口直接返回 mp3 URL
async function handleKuwoSongUrl(rid, quality) {
  const r = String(rid || '').trim();
  if (!r) return { provider: 'kuwo', url: '', error: 'MISSING_RID', playable: false };
  console.log('[KuwoSongUrl] rid:', r, 'quality:', quality || 'exhigh');
  try {
    // 根据音质档位选 br
    // 320kmp3 = 极高，128kmp3 = 标准，lossless = flac
    let br = '320kmp3';
    if (quality === 'standard') br = '128kmp3';
    else if (quality === 'lossless' || quality === 'hires') br = 'flac';
    const apiUrl = `http://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&response=url&rid=${r}&br=${br}`;
    const resp = await fetch(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'http://www.kuwo.cn/' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return { provider: 'kuwo', url: '', error: 'HTTP_' + resp.status, playable: false };
    const url = (await resp.text()).trim();
    if (url && url.startsWith('http')) {
      const level = br === 'flac' ? 'lossless' : (br === '128kmp3' ? 'standard' : 'exhigh');
      const brNum = br === 'flac' ? 940000 : (br === '128kmp3' ? 128000 : 320000);
      return {
        provider: 'kuwo',
        url,
        playable: true,
        trial: false,
        level,
        br: brNum,
        platform: 'kuwo',
      };
    }
    return { provider: 'kuwo', url: '', error: 'NO_URL', playable: false };
  } catch (err) {
    console.error('[KuwoSongUrl] error:', err.message);
    return { provider: 'kuwo', url: '', error: err.message, playable: false };
  }
}

// ========== 咪咕音乐搜索 ==========
// 使用 pd.musicapp.migu.cn 移动端接口（无需鉴权）
// 注意：咪咕的播放URL接口需要加密签名，公开拿不到，所以咪咕源只做搜索展示
async function handleMiguSearch(keywords, limit, offset) {
  const kw = String(keywords || '').trim();
  if (!kw) return [];
  const pageNo = Math.floor((offset || 0) / 20) + 1;
  const pageSize = Math.min(30, limit || 20);
  console.log('[MiguSearch]', kw, 'page:', pageNo, 'pagesize:', pageSize);
  try {
    const apiUrl = `https://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do?ua=Android_migu&version=5.0.1&text=${encodeURIComponent(kw)}&pageNo=${pageNo}&pageSize=${pageSize}&searchSwitch=${encodeURIComponent('{"song":1}')}`;
    const resp = await fetch(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36', 'Referer': 'https://m.music.migu.cn/' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) { console.warn('[MiguSearch] HTTP', resp.status); return []; }
    const json = await resp.json();
    const list = (json && json.songResultData && Array.isArray(json.songResultData.result)) ? json.songResultData.result : [];
    const seen = new Set();
    return list.filter(item => item && item.contentId && !seen.has(item.contentId) && (seen.add(item.contentId), true)).map(item => {
      const singers = Array.isArray(item.singers) ? item.singers.map(s => s.name || '').filter(Boolean) : [];
      const albums = Array.isArray(item.albums) ? item.albums : [];
      const imgItems = Array.isArray(item.imgItems) ? item.imgItems : [];
      // 找最大的封面图
      const cover = imgItems.length ? (imgItems[imgItems.length - 1].url || '') : '';
      return {
        provider: 'migu',
        source: 'migu',
        type: 'song',
        id: item.contentId,
        contentId: item.contentId,
        copyrightId: item.copyrightId || '',
        name: String(item.name || '').replace(/<\/?em>/g, ''),
        artist: singers.join(' / ') || '未知歌手',
        album: (albums[0] && albums[0].name) || '',
        cover: cover,
        duration: 0, // 接口无 duration
        fee: item.vipType === '1' ? 1 : 0,
        vipType: item.vipType || '',
        playable: true,
        // 咪咕播放URL需要加密签名，标记为降级播放
        playbackNote: 'migu_no_direct_url',
      };
    });
  } catch (err) {
    console.error('[MiguSearch] error:', err.message);
    return [];
  }
}

// ========== 音乐下载 ==========
const DEFAULT_DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const downloadTasks = new Map();
let downloadTaskIdCounter = 1;

function getDownloadDir() {
  if (!musicSourceConfig) loadMusicSourceConfig();
  const dir = (musicSourceConfig && musicSourceConfig.downloadDir) || DEFAULT_DOWNLOAD_DIR;
  return dir;
}

function ensureDownloadDir() {
  const dir = getDownloadDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return dir;
}

// 清理文件名中的非法字符
function sanitizeFileName(name) {
  return String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 200);
}

// 根据音质/格式确定扩展名
function extForQuality(level, br) {
  if (level === 'lossless' || level === 'hires' || level === 'jymaster') return 'flac';
  if (br && br >= 740000) return 'flac';
  return 'mp3';
}

// 生成不冲突的文件路径
function resolveUniqueFilePath(dir, baseName, ext) {
  let filePath = path.join(dir, baseName + '.' + ext);
  let i = 1;
  while (fs.existsSync(filePath)) {
    filePath = path.join(dir, baseName + ' (' + i + ').' + ext);
    i++;
  }
  return filePath;
}

// 获取下载用音频URL（复用现有的播放URL获取逻辑）
// 关键：下载时拒绝试听片段（freeTrialInfo），只有完整版才允许下载
async function getDownloadAudioUrl(provider, songData, quality) {
  if (provider === 'qq') {
    const qqResult = await handleQQSongUrl(songData.mid || songData.songmid || songData.id, songData.mediaMid, quality);
    if (qqResult && qqResult.url) return qqResult;
    // QQ直连+内部降级都失败，用歌名+歌手搜索网易云走unblock音源
    try {
      const artistName = (songData.artists || songData.ar || []).map(a => a.name || '').filter(Boolean).join(' ');
      const searchKw = ((songData.name || '') + ' ' + artistName).trim();
      if (searchKw) {
        const searchResult = await cloudsearch({ keywords: searchKw, limit: 5, cookie: userCookie });
        const songs = searchResult.body && searchResult.body.result && searchResult.body.result.songs;
        const matched = songs && songs.find(s => {
          const sName = (s.name || '').toLowerCase();
          const qName = (songData.name || '').toLowerCase();
          return sName.includes(qName) || qName.includes(sName);
        });
        if (matched && matched.id) {
          const platforms = getMusicSourceConfig();
          const unblockResult = await resolveUnblockMusic(matched.id, {
            id: matched.id, name: matched.name || '', alias: matched.alias || [],
            duration: matched.dt || matched.duration || 0,
            artists: (matched.artists || matched.ar || []).map(a => ({ id: a.id, name: a.name || '' })),
            album: { id: (matched.album || matched.al || {}).id, name: (matched.album || matched.al || {}).name || '' }
          }, platforms);
          if (unblockResult) {
            console.log('[Download] QQ降级失败，网易云搜索+unblock成功:', songData.name);
            return { provider: 'qq', ...unblockResult };
          }
        }
      }
    } catch (e) {
      console.log('[Download] QQ降级兜底失败:', e.message);
    }
    return qqResult;
  }
  if (provider === 'kugou') {
    // 根据音质选hash
    let hash = songData.hash || songData.id || '';
    if (quality === 'lossless' || quality === 'hires') {
      hash = songData.sqHash || songData.hqHash || hash;
    } else if (quality === 'exhigh') {
      hash = songData.hqHash || hash;
    }
    return await handleKugouSongUrl(hash);
  }
  if (provider === 'kuwo') {
    return await handleKuwoSongUrl(songData.rid || songData.id, quality);
  }
  if (provider === 'migu') {
    return { url: '', error: 'MIGU_NO_DIRECT_URL', playable: false };
  }
  // netease: handleSongUrl 内部已尝试官方+多平台unblock音源
  // 下载场景下拒绝试听版（避免下载到二三十秒的片段）
  // 关键：必须传登录态，否则未登录时官方接口会返回试听版
  const loginInfo = await getLoginInfo();
  const result = await handleSongUrl(songData.id, loginInfo, quality);
  if (result && result.trial) {
    console.log('[Download] 拒绝试听片段:', songData.name, '- 所有音源均无法获取完整版');
    return { url: '', error: '仅为试听片段，无法下载', playable: false };
  }
  return result;
}

// 开始下载任务
async function startDownloadTask(taskId, songData, quality, provider) {
  const task = downloadTasks.get(taskId);
  if (!task) return;
  task.status = 'downloading';
  task.startedAt = Date.now();

  try {
    // 1. 获取音频URL
    const audioData = await getDownloadAudioUrl(provider, songData, quality);
    if (!audioData || !audioData.url) {
      task.status = 'failed';
      task.error = (audioData && audioData.error) ? audioData.error : 'NO_URL';
      console.log('[Download] 失败(无URL):', task.songName, task.error);
      return;
    }
    task.url = audioData.url;
    task.level = audioData.level || quality;
    task.br = audioData.br || 0;

    // 2. 确定文件路径
    const dir = ensureDownloadDir();
    const baseName = sanitizeFileName((songData.artist || '未知歌手') + ' - ' + (songData.name || '未知歌曲'));
    const ext = extForQuality(audioData.level, audioData.br);
    task.filePath = resolveUniqueFilePath(dir, baseName, ext);
    task.ext = ext;

    // 3. 流式下载
    const controller = new AbortController();
    task.controller = controller;

    const resp = await fetch(audioData.url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA },
    });

    if (!resp.ok) {
      task.status = 'failed';
      task.error = 'HTTP_' + resp.status;
      console.log('[Download] 失败(HTTP):', task.songName, task.error);
      return;
    }

    task.totalBytes = parseInt(resp.headers.get('content-length') || '0', 10);

    const fileStream = fs.createWriteStream(task.filePath);
    const reader = resp.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (task.status === 'cancelled') {
        fileStream.destroy();
        try { fs.unlinkSync(task.filePath); } catch (e) {}
        return;
      }
      fileStream.write(Buffer.from(value));
      task.downloadedBytes += value.length;
    }

    fileStream.end();
    await new Promise(function(resolve) { fileStream.on('finish', resolve); });

    task.status = 'completed';
    task.completedAt = Date.now();
    console.log('[Download] 完成:', task.songName, '->', task.filePath);
  } catch (err) {
    if (err.name === 'AbortError' || task.status === 'cancelled' || task.status === 'paused') {
      try { if (task.filePath) fs.unlinkSync(task.filePath); } catch (e) {}
      return;
    }
    task.status = 'failed';
    task.error = err.message;
    console.error('[Download] 失败:', task.songName, err.message);
  } finally {
    persistDownloadTasksDebounced();
  }
}

function serializeDownloadTask(task) {
  return {
    id: task.id,
    status: task.status,
    songName: task.songName,
    artist: task.artist,
    provider: task.provider,
    quality: task.quality,
    level: task.level,
    br: task.br,
    totalBytes: task.totalBytes,
    downloadedBytes: task.downloadedBytes,
    filePath: task.filePath,
    error: task.error,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    ext: task.ext,
    songData: task.songData || null,
  };
}

// ========== 下载任务持久化（重启后保留进度和记录） ==========
const DOWNLOAD_TASKS_FILE = path.join(__dirname, 'config', 'download-tasks.json');
let downloadTasksPersistTimer = null;

function persistDownloadTasksDebounced() {
  if (downloadTasksPersistTimer) clearTimeout(downloadTasksPersistTimer);
  downloadTasksPersistTimer = setTimeout(persistDownloadTasks, 800);
}

function persistDownloadTasks() {
  try {
    const arr = Array.from(downloadTasks.values()).map(serializeDownloadTask);
    fs.mkdirSync(path.dirname(DOWNLOAD_TASKS_FILE), { recursive: true });
    fs.writeFileSync(DOWNLOAD_TASKS_FILE, JSON.stringify({ tasks: arr, nextId: downloadTaskIdCounter }, null, 2), 'utf8');
  } catch (e) {
    console.warn('[Download] persist failed:', e.message);
  }
}

// 启动时加载持久化的任务：下载中/等待中的转为已暂停（文件可能不完整，重置进度）
function loadPersistedDownloadTasks() {
  try {
    if (!fs.existsSync(DOWNLOAD_TASKS_FILE)) return;
    const raw = fs.readFileSync(DOWNLOAD_TASKS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.tasks)) return;
    parsed.tasks.forEach(function(t) {
      if (t.status === 'downloading' || t.status === 'pending') {
        t.status = 'paused';
        t.downloadedBytes = 0;
      }
      const task = {
        id: t.id,
        status: t.status,
        songName: t.songName || '',
        artist: t.artist || '',
        provider: t.provider || 'netease',
        quality: t.quality || 'exhigh',
        songData: t.songData || null,
        totalBytes: t.totalBytes || 0,
        downloadedBytes: t.downloadedBytes || 0,
        filePath: t.filePath || '',
        error: t.error || null,
        createdAt: t.createdAt || Date.now(),
        completedAt: t.completedAt || 0,
        level: t.level,
        br: t.br,
        ext: t.ext,
        controller: null,
        startedAt: 0,
      };
      if (task.id >= downloadTaskIdCounter) downloadTaskIdCounter = task.id + 1;
      downloadTasks.set(task.id, task);
    });
    console.log('[Download] restored', downloadTasks.size, 'tasks from disk');
  } catch (e) {
    console.warn('[Download] load persisted failed:', e.message);
  }
}
loadPersistedDownloadTasks();

// ========== Wallpaper Engine 壁纸读取 ==========
const WE_APP_ID = '431960';
let weWallpaperCache = [];
let weWallpaperCacheTime = 0;
const WE_CACHE_TTL = 60000; // 1分钟缓存

async function getSteamInstallPath() {
  if (process.platform !== 'win32') return null;
  try {
    const { exec } = require('child_process');
    const result = await new Promise((resolve, reject) => {
      exec('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath', (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      });
    });
    const match = result.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (match && match[1]) return match[1].trim();
  } catch (e) {
    console.log('[WallpaperEngine] 读取Steam注册表失败:', e.message);
  }
  return null;
}

function parseLibraryFoldersVdf(content) {
  const paths = [];
  const regex = /"path"\s+"([^"]+)"/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    paths.push(match[1].replace(/\\\\/g, '\\'));
  }
  return paths;
}

async function getSteamLibraryPaths() {
  const steamPath = await getSteamInstallPath();
  if (!steamPath) {
    // 常见路径兜底
    return [
      'C:\\Program Files (x86)\\Steam',
      'C:\\Program Files\\Steam',
      'D:\\Steam',
      'E:\\Steam',
    ].filter(p => fs.existsSync(path.join(p, 'steamapps')));
  }
  const libraryFoldersFile = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
  const paths = [steamPath];
  if (fs.existsSync(libraryFoldersFile)) {
    try {
      const content = fs.readFileSync(libraryFoldersFile, 'utf8');
      const libraryPaths = parseLibraryFoldersVdf(content);
      for (const p of libraryPaths) {
        if (!paths.includes(p) && fs.existsSync(path.join(p, 'steamapps'))) {
          paths.push(p);
        }
      }
    } catch (e) {
      console.log('[WallpaperEngine] 解析libraryfolders.vdf失败:', e.message);
    }
  }
  return paths;
}

function getWeWallpaperDir(libraryPath) {
  return path.join(libraryPath, 'steamapps', 'workshop', 'content', WE_APP_ID);
}

function readProjectJson(wallpaperDir) {
  const projPath = path.join(wallpaperDir, 'project.json');
  if (!fs.existsSync(projPath)) return null;
  try {
    const raw = fs.readFileSync(projPath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function findPreviewImage(wallpaperDir, projectData) {
  // 优先用 project.json 里的 preview 字段
  if (projectData && projectData.preview) {
    const previewPath = path.join(wallpaperDir, projectData.preview);
    if (fs.existsSync(previewPath)) return previewPath;
  }
  // 兜底：找目录里的图片文件
  try {
    const files = fs.readdirSync(wallpaperDir);
    const exts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const imgFile = files.find(f => exts.includes(path.extname(f).toLowerCase()));
    if (imgFile) return path.join(wallpaperDir, imgFile);
  } catch (e) {}
  return null;
}

function findVideoFile(wallpaperDir, projectData) {
  // 视频类型壁纸，找视频文件
  if (projectData && projectData.file) {
    const videoExts = ['.mp4', '.webm', '.mov', '.mkv', '.avi'];
    const file = String(projectData.file);
    if (videoExts.includes(path.extname(file).toLowerCase())) {
      const videoPath = path.join(wallpaperDir, file);
      if (fs.existsSync(videoPath)) return videoPath;
    }
  }
  // 兜底：找目录里的视频文件
  try {
    const files = fs.readdirSync(wallpaperDir);
    const exts = ['.mp4', '.webm', '.mov', '.mkv'];
    const videoFile = files.find(f => exts.includes(path.extname(f).toLowerCase()));
    if (videoFile) return path.join(wallpaperDir, videoFile);
  } catch (e) {}
  return null;
}

async function scanWallpaperEngineWallpapers() {
  const now = Date.now();
  if (weWallpaperCache.length > 0 && now - weWallpaperCacheTime < WE_CACHE_TTL) {
    return weWallpaperCache;
  }
  const libraryPaths = await getSteamLibraryPaths();
  const wallpapers = [];
  const seenIds = new Set();
  for (const libPath of libraryPaths) {
    const weDir = getWeWallpaperDir(libPath);
    if (!fs.existsSync(weDir)) continue;
    try {
      const dirs = fs.readdirSync(weDir);
      for (const dir of dirs) {
        if (seenIds.has(dir)) continue;
        const fullDir = path.join(weDir, dir);
        const stat = fs.statSync(fullDir);
        if (!stat.isDirectory()) continue;
        const projectData = readProjectJson(fullDir);
        if (!projectData) continue;
        const preview = findPreviewImage(fullDir, projectData);
        const video = findVideoFile(fullDir, projectData);
        const type = projectData.type || (video ? 'video' : 'image');
        seenIds.add(dir);
        wallpapers.push({
          id: dir,
          title: projectData.title || dir,
          type: type,
          preview: preview,
          video: video,
          dir: fullDir,
          workshopId: dir,
        });
      }
    } catch (e) {
      console.log('[WallpaperEngine] 扫描目录失败:', weDir, e.message);
    }
  }
  weWallpaperCache = wallpapers;
  weWallpaperCacheTime = now;
  console.log(`[WallpaperEngine] 扫描到 ${wallpapers.length} 个壁纸`);
  return wallpapers;
}

async function handleQQSongUrl(mid, mediaMid, qualityPreference) {
  const songmid = String(mid || '').trim();
  if (!songmid) return { provider: 'qq', url: '', error: 'MISSING_MID', message: 'Missing QQ song mid' };
  const guid = String(10000000 + Math.floor(Math.random() * 90000000));
  const cookieObj = qqCookieObject();
  const uin = qqCookieUin(cookieObj) || '0';
  const musicKey = qqCookieMusicKey(cookieObj);
  const playbackKey = qqCookiePlaybackKey(cookieObj);
  const fileMediaMid = String(mediaMid || '').trim();
  const requestedQuality = normalizeQualityPreference(qualityPreference);
  const mediaIds = [];
  if (fileMediaMid) mediaIds.push(fileMediaMid);
  if (songmid && !mediaIds.includes(songmid)) mediaIds.push(songmid);
  const fileCandidates = mediaIds.flatMap(mediaId =>
    qualityCandidatesFrom(requestedQuality, QQ_QUALITY_CANDIDATE_TEMPLATES)
      .map(item => ({ ...item, mediaId, filename: item.prefix + mediaId + item.ext }))
  );
  const filenames = fileCandidates.map(item => item.filename);
  const param = {
    guid,
    songmid: filenames.length ? filenames.map(() => songmid) : [songmid],
    songtype: filenames.length ? filenames.map(() => 0) : [0],
    uin,
    loginflag: 1,
    platform: '20',
  };
  if (filenames.length) param.filename = filenames;
  const comm = { uin, format: 'json', ct: musicKey ? 19 : 24, cv: 0 };
  if (musicKey) comm.authst = musicKey;
  const json = await qqMusicRequest({
    comm,
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param,
    },
  }, { cookie: true });
  const data = json && json.req_0 && json.req_0.data;
  const infos = (data && Array.isArray(data.midurlinfo)) ? data.midurlinfo : [];
  const info = infos.find(item => item && item.purl) || infos[0];
  const purl = info && info.purl;
  if (purl) {
    const sip = (data.sip && data.sip[0]) || 'https://ws.stream.qqmusic.qq.com/';
    const fileMeta = fileCandidates.find(item => item.filename === info.filename) || {};
    return {
      provider: 'qq',
      url: sip + purl,
      trial: false,
      playable: true,
      level: fileMeta.level || info.filename || '',
      quality: fileMeta.label || info.filename || '',
      filename: info.filename || '',
      requestedQuality,
    };
  }
  const restriction = classifyQQPlaybackRestriction(info, {
    hasSession: !!(uin && musicKey),
    hasPlaybackKey: !!(uin && playbackKey),
  });
  
  // QQ 播放失败 → 先用歌名搜索网易云获取真实ID → 走多平台音源（仿 AlgerMusicPlayer）
  console.log(`[QQSongUrl] QQ失败，尝试网易云搜索+多平台音源降级...`);
  try {
    let qqInfo = await qqSongDetail(songmid, null);
    if (qqInfo && qqInfo.name) {
      // 用歌名+歌手搜索网易云，获取真实歌曲ID
      const artistName = (qqInfo.artists || []).map(a => a.name).filter(Boolean).join(' ');
      const searchKw = (qqInfo.name + ' ' + artistName).trim();
      const searchResult = await cloudsearch({ keywords: searchKw, limit: 5, cookie: userCookie });
      const songs = searchResult.body && searchResult.body.result && searchResult.body.result.songs;
      const matchedSong = songs && songs.find(s => {
        const sName = (s.name || '').toLowerCase();
        const qName = (qqInfo.name || '').toLowerCase();
        return sName.includes(qName) || qName.includes(sName);
      });
      
      if (matchedSong && matchedSong.id) {
        const neteaseId = matchedSong.id;
        const platforms = getMusicSourceConfig();
        const unblockResult = await resolveUnblockMusic(neteaseId, {
          id: neteaseId,
          name: matchedSong.name || '',
          alias: matchedSong.alias || [],
          duration: matchedSong.dt || matchedSong.duration || 0,
          artists: (matchedSong.artists || matchedSong.ar || []).map(a => ({ id: a.id, name: a.name || '' })),
          album: { id: (matchedSong.album || matchedSong.al || {}).id, name: (matchedSong.album || matchedSong.al || {}).name || '' }
        }, platforms);
        if (unblockResult) {
          console.log(`[QQSongUrl] ✅ 网易云搜索+多平台音源成功: ${qqInfo.name}`);
          return { provider: 'qq', ...unblockResult };
        }
      }
    }
  } catch (e) {
    console.log('[QQSongUrl] 网易云搜索+多平台音源降级失败:', e.message);
  }
  
  return {
    provider: 'qq',
    url: '',
    playable: false,
    error: 'QQ_URL_UNAVAILABLE',
    loggedIn: !!(uin && musicKey),
    playbackKeyReady: !!(uin && playbackKey),
    restriction,
    reason: restriction.category,
    message: restriction.message,
    qqCode: info && (info.result || info.code || info.errtype),
    rawMessage: info && (info.msg || info.tips || info.errmsg || ''),
    tried: fileCandidates.map(item => item.label + ' · ' + item.filename),
    requestedQuality,
  };
}

function mapQQComment(raw) {
  raw = raw || {};
  const user = raw.user || raw.uin || {};
  const nickname = raw.nick || raw.nickname || raw.encrypt_uin || user.nick || user.nickname || user.name || 'QQ 音乐用户';
  const avatar = raw.avatarurl || raw.avatar || user.avatarurl || user.avatar || '';
  const timeRaw = Number(raw.time || raw.commenttime || raw.createTime || 0) || 0;
  return {
    id: raw.commentid || raw.commentId || raw.id || '',
    content: raw.rootcommentcontent || raw.content || raw.comment || '',
    likedCount: Number(raw.praisenum || raw.praise_num || raw.likedCount || 0) || 0,
    time: timeRaw && timeRaw < 10000000000 ? timeRaw * 1000 : timeRaw,
    user: {
      id: raw.encrypt_uin || raw.uin || user.uin || '',
      nickname,
      avatar,
    },
  };
}

async function handleQQSongComments(id, mid, limit, offset) {
  let topid = String(id || '').replace(/\D/g, '');
  if (!topid && mid) {
    try {
      const detail = await qqSongDetail(mid, { mid });
      topid = String((detail && (detail.qqId || detail.id)) || '').replace(/\D/g, '');
    } catch (e) {
      console.warn('[QQComments] detail fallback failed:', e.message);
    }
  }
  if (!topid) return { provider: 'qq', error: 'Missing QQ song id', comments: [] };
  const page = Math.max(0, Math.floor((offset || 0) / Math.max(1, limit || 20)));
  const uin = qqCookieUin() || '0';
  const body = await qqGetJSON('https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_h5.fcg', {
    g_tk: '5381',
    loginUin: uin,
    hostUin: '0',
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: '0',
    platform: 'yqq.json',
    needNewCode: '0',
    cid: '205360772',
    reqtype: '2',
    biztype: '1',
    topid,
    cmd: '8',
    needmusiccrit: '0',
    pagenum: String(page),
    pagesize: String(limit || 20),
  }, { headers: { Referer: 'https://y.qq.com/n/ryqq/songDetail/' + encodeURIComponent(mid || topid) } });
  const hotList = body && body.hot_comment && body.hot_comment.commentlist;
  const normalList = body && body.comment && body.comment.commentlist;
  const raw = (offset === 0 && Array.isArray(hotList) && hotList.length) ? hotList : (normalList || []);
  const comments = (raw || []).map(mapQQComment).filter(c => c.content);
  const total = Number(body && body.comment && (body.comment.commenttotal || body.comment.comment_total)) || comments.length;
  return { provider: 'qq', id: topid, total, comments, hot: !!(offset === 0 && Array.isArray(hotList) && hotList.length) };
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}

function decodeQQLyricText(text) {
  let raw = decodeHtmlEntities(String(text || '').trim());
  if (!raw) return '';
  const compact = raw.replace(/\s+/g, '');
  const looksBase64 = compact.length >= 8 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
  if (looksBase64 && !/^\s*\[/.test(raw)) {
    try {
      const decoded = Buffer.from(compact, 'base64').toString('utf8').replace(/^\uFEFF/, '');
      if (decoded && (decoded.includes('[') || /[\u4e00-\u9fa5]/.test(decoded))) raw = decoded;
    } catch (e) {
      console.warn('[QQLyric] base64 decode failed:', e.message);
    }
  }
  return decodeHtmlEntities(raw).replace(/\r\n/g, '\n').trim();
}

function normalizeQQSongId(id) {
  const n = String(id || '').replace(/\D/g, '');
  return n ? Number(n) : 0;
}

async function handleQQLyric(mid, id) {
  const songMID = String(mid || '').trim();
  const songID = normalizeQQSongId(id);
  if (!songMID && !songID) return { provider: 'qq', error: 'Missing QQ song mid or id', lyric: '' };

  let lyricText = '';
  let transText = '';
  let qrcText = '';
  let romaText = '';
  let source = 'qq-musicu';

  try {
    const param = {};
    if (songMID) param.songMID = songMID;
    if (songID) param.songID = songID;
    const json = await qqMusicRequest({
      comm: { ct: 24, cv: 0 },
      lyric: {
        module: 'music.musichallSong.PlayLyricInfo',
        method: 'GetPlayLyricInfo',
        param,
      },
    }, { cookie: true });
    const data = json && json.lyric && json.lyric.data;
    lyricText = decodeQQLyricText(data && data.lyric);
    transText = decodeQQLyricText(data && data.trans);
    qrcText = decodeQQLyricText(data && data.qrc);
    romaText = decodeQQLyricText(data && data.roma);
  } catch (e) {
    console.warn('[QQLyric] musicu failed:', e.message);
  }

  if (!lyricText && songMID) {
    try {
      const body = await qqGetJSON('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg', {
        songmid: songMID,
        songtype: '0',
        format: 'json',
        nobase64: '1',
        g_tk: '5381',
        loginUin: qqCookieUin() || '0',
        hostUin: '0',
        inCharset: 'utf8',
        outCharset: 'utf-8',
        notice: '0',
        platform: 'yqq.json',
        needNewCode: '0',
      }, { headers: { Referer: 'https://y.qq.com/portal/player.html' } });
      lyricText = decodeQQLyricText(body && body.lyric);
      transText = decodeQQLyricText(body && (body.trans || body.tlyric)) || transText;
      source = 'qq-legacy';
    } catch (e) {
      console.warn('[QQLyric] legacy failed:', e.message);
    }
  }

  return {
    provider: 'qq',
    id: songID || '',
    mid: songMID,
    lyric: lyricText,
    tlyric: transText,
    yrc: '',
    qrc: qrcText,
    roma: romaText,
    source: lyricText ? source : 'qq-empty',
  };
}

function mapPodcastRadio(r) {
  r = r || {};
  const dj = r.dj || r.djSimple || r.djUser || r.creator || {};
  const id = r.id || r.rid || r.radioId;
  return {
    id,
    rid: id,
    name: r.name || r.radioName || '',
    cover: r.picUrl || r.picURL || r.coverUrl || r.coverImgUrl || r.avatarUrl || '',
    desc: r.desc || r.description || r.rcmdText || '',
    djName: dj.nickname || r.djName || r.nickname || '',
    category: r.category || r.categoryName || '',
    programCount: r.programCount || r.programNum || r.programCnt || 0,
    subCount: r.subCount || r.subedCount || r.subscriberCount || 0,
  };
}

function mapPodcastProgram(p, fallbackRadio) {
  p = p || {};
  const mainSong = p.mainSong || p.song || p.mainTrack || {};
  const radio = p.radio || fallbackRadio || {};
  const mappedRadio = mapPodcastRadio(radio);
  const artists = mapArtists(mainSong.ar || mainSong.artists || []);
  const album = mainSong.al || mainSong.album || {};
  const dj = p.dj || radio.dj || {};
  const playableId = mainSong.id || p.mainSongId || p.songId;
  return {
    type: 'podcast',
    source: 'podcast',
    id: playableId,
    programId: p.id || p.programId,
    radioId: mappedRadio.id,
    name: p.name || mainSong.name || '',
    artist: mappedRadio.name || dj.nickname || artists.map(a => a.name).join(' / ') || mappedRadio.djName || '',
    artists,
    artistId: artists[0] && artists[0].id,
    album: mappedRadio.name || album.name || 'Podcast',
    cover: p.coverUrl || p.cover || p.blurCoverUrl || mappedRadio.cover || album.picUrl || '',
    duration: p.duration || mainSong.dt || mainSong.duration || 0,
    fee: mainSong.fee,
    djName: mappedRadio.djName || dj.nickname || '',
    radioName: mappedRadio.name || '',
    desc: p.description || p.desc || '',
    createTime: p.createTime || 0,
    serialNum: p.serialNum || p.serial || 0,
  };
}

function firstArrayFrom(obj, keys) {
  obj = obj || {};
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.list)) return value.list;
    if (value && Array.isArray(value.data)) return value.data;
    if (value && Array.isArray(value.resources)) return value.resources;
  }
  return [];
}

function mapPodcastVoice(v) {
  v = v || {};
  const raw = v.resource || v.voice || v.data || v.program || v;
  const mainSong = raw.mainSong || raw.song || raw.track || {};
  const radio = raw.radio || raw.djRadio || raw.voiceList || raw.podcast || {};
  const playableId = raw.trackId || raw.songId || raw.mainSongId || mainSong.id || raw.id;
  return {
    type: 'podcast',
    source: 'podcast',
    sourceType: 'podcast-voice',
    id: playableId,
    programId: raw.programId || raw.voiceId || raw.id,
    radioId: radio.id || radio.radioId || radio.voiceListId || raw.radioId || raw.voiceListId,
    name: raw.name || raw.songName || raw.title || mainSong.name || '',
    artist: (radio.name || radio.radioName || radio.voiceListName || raw.podcastName || raw.djName || 'Voice'),
    album: radio.name || radio.radioName || raw.podcastName || 'Podcast',
    cover: raw.coverUrl || raw.cover || raw.picUrl || raw.coverImgUrl || radio.picUrl || radio.coverUrl || '',
    duration: raw.duration || raw.durationMs || mainSong.dt || mainSong.duration || 0,
    djName: raw.djName || (radio.dj && radio.dj.nickname) || '',
    radioName: radio.name || radio.radioName || raw.podcastName || '',
    desc: raw.desc || raw.description || '',
  };
}

function mapPodcastCollectionRadio(r, key) {
  const radio = mapPodcastRadio(r);
  return {
    ...radio,
    type: 'podcast-radio',
    sourceType: 'podcast-radio',
    collectionKey: key || '',
    radioId: radio.id,
    name: radio.name,
    artist: radio.djName || radio.category || 'Podcast',
    album: radio.category || 'Podcast',
  };
}

function podcastCollectionMeta(key, items) {
  const meta = {
    collect: { key: 'collect', title: '收藏播客', sub: '你收藏的播客', itemType: 'radio' },
    created: { key: 'created', title: '创建播客', sub: '你创建的播客', itemType: 'radio' },
    liked: { key: 'liked', title: '喜欢的声音', sub: '收藏或最近喜欢的声音', itemType: 'voice' },
  }[key] || { key, title: key, sub: '', itemType: 'radio' };
  const first = (items || [])[0] || {};
  return {
    ...meta,
    count: (items || []).length,
    cover: first.cover || first.picUrl || first.coverUrl || '',
  };
}

async function fetchMyPodcastItems(key, info, limit, offset) {
  limit = Math.max(8, Math.min(60, Number(limit) || 30));
  offset = Math.max(0, Number(offset) || 0);
  if (key === 'collect') {
    const r = await dj_sublist({ limit, offset, cookie: userCookie, timestamp: Date.now() });
    const raw = firstArrayFrom(r.body, ['djRadios', 'djradios', 'radios', 'data']);
    return { itemType: 'radio', items: raw.map(x => mapPodcastCollectionRadio(x, key)).filter(x => x.id) };
  }
  if (key === 'created') {
    const r = await user_audio({ uid: info.userId, cookie: userCookie, timestamp: Date.now() });
    const raw = firstArrayFrom(r.body, ['data', 'djRadios', 'djradios', 'radios']);
    return { itemType: 'radio', items: raw.map(x => mapPodcastCollectionRadio(x, key)).filter(x => x.id) };
  }
  if (key === 'paid') {
    const r = await dj_paygift({ limit, offset, cookie: userCookie, timestamp: Date.now() });
    const raw = firstArrayFrom(r.body, ['data', 'djRadios', 'djradios', 'radios']);
    return { itemType: 'radio', items: raw.map(x => mapPodcastCollectionRadio(x, key)).filter(x => x.id) };
  }
  if (key === 'liked') {
    let raw = [];
    try {
      const sati = await sati_resource_sub_list({ cookie: userCookie, timestamp: Date.now() });
      raw = firstArrayFrom(sati.body, ['data', 'resources', 'list']);
    } catch (e) {
      console.warn('[MyPodcastLiked] sati sub list failed:', e.message);
    }
    if (!raw.length) {
      try {
        const recent = await record_recent_voice({ limit, cookie: userCookie, timestamp: Date.now() });
        raw = firstArrayFrom(recent.body, ['data', 'list', 'resources']);
      } catch (e) {
        console.warn('[MyPodcastLiked] recent voice fallback failed:', e.message);
      }
    }
    return { itemType: 'voice', items: raw.map(mapPodcastVoice).filter(x => x.id && x.name) };
  }
  return { itemType: 'radio', items: [] };
}

// ---------- 业务: 取歌曲URL (探测试听) ----------
//   返回 { url, trial, level, br }
//   trial=true 表示这是试听片段 (freeTrialInfo 非空)
//   降级链路: 网易云 → unblockMusic (咪咕/酷狗/酷我/PyNCM) → GD Music (Joox/Tidal)
async function handleSongUrl(id, loginInfo, qualityPreference) {
  console.log('[SongUrl] id:', id, 'logged-in:', !!userCookie);
  const requestedQuality = normalizeQualityPreference(qualityPreference);
  const svipReady = hasNeteaseSvip(loginInfo);
  const qualities = qualityCandidatesFrom(requestedQuality, NETEASE_QUALITY_CANDIDATES)
    .filter(q => !q.svip || svipReady);

  let trialFallback = null; // 兜底: 即使是试听也要能播
  let lastData = null;
  let lastError = null;

  for (const q of qualities) {
    try {
      // 优先用 v1 接口 (支持更高音质 level 字段)
      let result;
      try {
        result = await song_url_v1({ id, level: q.level, cookie: userCookie });
      } catch (e) {
        result = await song_url({ id, br: q.br, cookie: userCookie });
      }
      const d = result.body && result.body.data && result.body.data[0];
      if (d) lastData = d;
      const url = d && d.url;
      const freeTrial = d && d.freeTrialInfo;
      console.log('[SongUrl]', q.level, '->', url ? 'OK' : 'no url', freeTrial ? '(TRIAL)' : '');
      if (url && !freeTrial) {
        return { url, trial: false, playable: true, level: q.level, quality: q.label, br: d.br, requestedQuality };
      }
      if (url && freeTrial && !trialFallback) {
        trialFallback = {
          url,
          trial: true,
          playable: true,
          level: q.level,
          quality: q.label,
          br: d.br,
          requestedQuality,
          trialInfo: freeTrial,
          restriction: classifyNeteasePlaybackRestriction(d, loginInfo),
        };
      }
    } catch (err) {
      lastError = err;
      console.log('[SongUrl]', q.level, 'failed:', err.message);
    }
  }

  // 网易云失败或仅试听 → 尝试多平台音源解锁
  if (lastData) {
    const restriction = classifyNeteasePlaybackRestriction(lastData, loginInfo);
    const needsFallback = ['trial_only', 'vip_required', 'paid_required', 'copyright_unavailable', 'url_unavailable'].includes(restriction.category);
    
    if (needsFallback) {
      console.log(`[SongUrl] 🔄 网易云${restriction.message}，尝试多平台音源...`);
      
      // 获取歌曲完整信息用于音源匹配 (完整字段，供 @unblockneteasemusic 使用)
      let songDetail = null;
      try {
        const detailResult = await song_detail({ ids: [parseInt(String(id), 10)].join(','), cookie: userCookie });
        const s = detailResult.body && detailResult.body.songs && detailResult.body.songs[0];
        if (s) {
          songDetail = {
            id: s.id,
            name: s.name || '',
            alias: s.alias || [],
            duration: s.dt || s.duration || 0,
            artists: (s.artists || s.ar || []).map(a => ({
              id: a.id,
              name: a.name || ''
            })),
            album: {
              id: (s.album || s.al || {}).id,
              name: (s.album || s.al || {}).name || ''
            }
          };
        }
      } catch (e) { /* ignore */ }

      // Step 1: @unblockneteasemusic (咪咕/酷狗/酷我/PyNCM)
      const enabledPlatforms = getMusicSourceConfig();
      const unblockResult = await resolveUnblockMusic(id, songDetail, enabledPlatforms);
      if (unblockResult) {
        console.log('[SongUrl] ✅ 多平台音源成功:', unblockResult.platform);
        return { ...unblockResult, requestedQuality };
      }

      // Step 2: LX Music（洛雪音源，priority=0 最高优先级）
      const lxResult = await resolveLxMusic(id, songDetail || lastData);
      if (lxResult) {
        console.log('[SongUrl] ✅ LX Music 成功');
        return { ...lxResult, requestedQuality };
      }

      // Step 3: Custom API（自定义API，priority=1）
      const customResult = await resolveCustomAudioSource(id, songDetail || lastData);
      if (customResult) {
        console.log('[SongUrl] ✅ 自定义API成功');
        return { ...customResult, requestedQuality };
      }

      // Step 4: GD Music (Joox/Tidal，priority=3)
      const gdResult = await resolveGDMusic(id, songDetail || lastData);
      if (gdResult) {
        console.log('[SongUrl] ✅ GD Music 成功');
        return { ...gdResult, requestedQuality };
      }

      // Step 5: UnblockMusic (migu/kugou/kuwo/pyncmd，priority=4 兜底)
      // 注意：getMusicSourceConfig 已经过滤掉非 unblock 平台

      console.log('[SongUrl] ❌ 所有音源均失败');
    }
  }

  if (trialFallback) return trialFallback;
  const restriction = classifyNeteasePlaybackRestriction(lastData, loginInfo);
  return {
    url: null,
    trial: false,
    playable: false,
    reason: restriction.category,
    message: restriction.message,
    restriction,
    lastCode: lastData && lastData.code,
    fee: lastData && lastData.fee,
    error: lastError && lastError.message,
    requestedQuality,
  };
}

// ---------- 业务: 登录态/用户信息 ----------
function readCookieFromResponse(resp) {
  const candidates = [
    resp && resp.cookie,
    resp && resp.body && resp.body.cookie,
    resp && resp.body && resp.body.data && resp.body.data.cookie,
    resp && resp.body && resp.body.data && resp.body.data.cookies,
  ];
  for (const candidate of candidates) {
    const cookie = normalizeCookieHeader(candidate);
    if (cookie) return cookie;
  }
  return '';
}
function firstPositiveNumberFrom(objects, keys) {
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') continue;
    for (const key of keys) {
      const value = Number(obj[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return 0;
}
function collectStringValues(value, out, depth) {
  if (depth > 4 || value == null) return out;
  if (typeof value === 'string') {
    if (value) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectStringValues(item, out, depth + 1));
    return out;
  }
  if (typeof value === 'object') {
    Object.keys(value).forEach(key => collectStringValues(value[key], out, depth + 1));
  }
  return out;
}
function collectVipStringValues(value, out, depth) {
  if (depth > 4 || value == null) return out;
  if (Array.isArray(value)) {
    value.forEach(item => collectVipStringValues(item, out, depth + 1));
    return out;
  }
  if (typeof value !== 'object') return out;
  Object.keys(value).forEach(key => {
    const child = value[key];
    if (/vip|svip|member|associator|privilege|right|level|package|label|title|type/i.test(key)) {
      collectStringValues(child, out, depth + 1);
    } else if (child && typeof child === 'object') {
      collectVipStringValues(child, out, depth + 1);
    }
  });
  return out;
}
function normalizeNeteaseVip(profile, account, extra) {
  profile = profile || {};
  account = account || {};
  extra = extra || {};
  const vipInfo = profile.vipInfo || profile.vipinfo || account.vipInfo || account.vipinfo || extra.vipInfo || extra.vipinfo || {};
  const objects = [account, profile, vipInfo, extra];
  const vipType = firstPositiveNumberFrom(objects, [
    'vipType', 'vip_type', 'viptype', 'musicVipType', 'music_vip_type',
    'musicVipLevel', 'music_vip_level', 'redVipLevel', 'red_vip_level',
    'blackVipLevel', 'black_vip_level', 'luxuryVipLevel', 'luxury_vip_level',
    'svipType', 'svip_type',
  ]);
  const text = collectVipStringValues({ account, profile, vipInfo, extra }, [], 0).join(' ').toLowerCase();
  const svipFlag = objects.some(obj => obj && (
    obj.isSvip === true || obj.is_svip === true || obj.svip === true ||
    Number(obj.isSvip || obj.is_svip || obj.svip || obj.svipType || obj.svip_type || 0) > 0
  )) || /svip|supervip|super_vip|blackvip|black_vip|黑胶svip|超级会员/.test(text);
  const vipFlag = objects.some(obj => obj && (
    obj.isVip === true || obj.is_vip === true || obj.vip === true ||
    Number(obj.isVip || obj.is_vip || obj.vip || obj.vipFlag || obj.vipflag || 0) > 0
  )) || /vip|黑胶|会员/.test(text);
  const isSvip = svipFlag || vipType >= 10;
  const isVip = isSvip || vipFlag || vipType > 0;
  const vipLevel = isSvip ? 'svip' : (isVip ? 'vip' : 'none');
  return {
    vipType,
    vipLevel,
    isVip,
    isSvip,
    vipLabel: vipLevel === 'svip' ? 'SVIP' : (vipLevel === 'vip' ? 'VIP' : '无VIP'),
  };
}
function normalizeLoginInfo(profile, account, extra) {
  profile = profile || {};
  account = account || {};
  const userId = profile.userId || profile.user_id || profile.id || account.userId || account.id || '';
  if (!(userId || userId === 0)) return { loggedIn: false };
  const vip = normalizeNeteaseVip(profile, account, extra);
  return {
    loggedIn: true,
    userId,
    nickname: profile.nickname || profile.userName || '网易云用户',
    avatar: profile.avatarUrl || profile.avatar || '',
    ...vip,
  };
}
function isNeteaseAuthInvalidPayload(payload) {
  const code = normalizeApiCode(payload);
  if (code === 301 || code === 401) return true;
  const msg = normalizeApiMessage(payload);
  return /未登录|需要登录|请先登录|login/i.test(msg) && code >= 300;
}
async function getLoginInfo() {
  if (!userCookie) return { loggedIn: false, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };

  // login_status 对二维码 cookie 的资料刷新通常更及时；失败时再降级到 user_account。
  try {
    const st = await login_status({ cookie: userCookie, timestamp: Date.now() });
    const body = st.body || {};
    const data = body.data || body;
    const info = normalizeLoginInfo(data.profile || body.profile, data.account || body.account, data);
    if (info.loggedIn) return info;
  } catch (e) {
    console.warn('[Login] login_status failed:', e.message);
  }

  try {
    const acc = await user_account({ cookie: userCookie, timestamp: Date.now() });
    const body = acc.body || {};
    const info = normalizeLoginInfo(body.profile, body.account, body);
    if (info.loggedIn) return info;
    if (isNeteaseAuthInvalidPayload(acc)) saveCookie('');
    return { loggedIn: false, hasCookie: !!userCookie, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };
  } catch (e) {
    console.warn('[Login] account check failed:', e.message);
    return { loggedIn: false, hasCookie: !!userCookie, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };
  }
}

// ====================================================================
//  HTTP Server
// ====================================================================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const pn = url.pathname;

  if (pn === '/api/app/version') {
    sendJSON(res, {
      name: APP_PACKAGE.name || 'mineradio',
      productName: APP_PACKAGE.productName || 'Mineradio',
      version: APP_VERSION,
      update: {
        provider: UPDATE_CONFIG.provider,
        configured: UPDATE_CONFIG.configured,
        owner: UPDATE_CONFIG.owner,
        repo: UPDATE_CONFIG.repo,
        preview: UPDATE_CONFIG.preview,
        manifestOverride: !!UPDATE_CONFIG.manifest,
      },
    });
    return;
  }

  if (pn === '/api/update/latest') {
    try {
      sendJSON(res, await fetchLatestUpdateInfo());
    } catch (err) {
      sendJSON(res, {
        ...localUpdateFallback(err.message || 'Update check failed', { configured: UPDATE_CONFIG.configured }),
        error: err.message || 'Update check failed',
      });
    }
    return;
  }

  if (pn === '/api/update/download') {
    try {
      const info = await fetchLatestUpdateInfo();
      const job = startUpdateDownloadJob(info);
      sendJSON(res, job, job.ok ? 200 : 400);
    } catch (err) {
      console.error('[UpdateDownload]', err);
      sendJSON(res, { ok: false, error: err.message || 'UPDATE_DOWNLOAD_START_FAILED' }, 500);
    }
    return;
  }

  if (pn === '/api/update/download/status') {
    const id = url.searchParams.get('id') || '';
    const job = id
      ? updateDownloadJobs.get(id)
      : Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    sendJSON(res, publicUpdateJob(job), job ? 200 : 404);
    return;
  }

  if (pn === '/api/update/patch') {
    try {
      const info = await fetchLatestUpdateInfo();
      const job = startUpdatePatchJob(info);
      sendJSON(res, job, job.ok ? 200 : 400);
    } catch (err) {
      console.error('[UpdatePatch]', err);
      sendJSON(res, { ok: false, error: err.message || 'UPDATE_PATCH_START_FAILED' }, 500);
    }
    return;
  }

  if (pn === '/api/update/patch/status') {
    const id = url.searchParams.get('id') || '';
    const job = id
      ? updateDownloadJobs.get(id)
      : Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).find(item => item.mode === 'patch');
    sendJSON(res, publicUpdateJob(job), job ? 200 : 404);
    return;
  }

  if (pn === '/api/beatmap/cache/status') {
    const info = beatCacheRootInfo();
    sendJSON(res, {
      enabled: info.allowed && info.available,
      dir: info.dir,
      drive: info.drive,
      reason: !info.allowed ? 'C_DRIVE_DISABLED' : (!info.available ? 'TARGET_DRIVE_UNAVAILABLE' : ''),
      mode: info.allowed && info.available ? 'disk' : 'memory-only',
    });
    return;
  }

  if (pn === '/api/beatmap/cache') {
    if (req.method === 'GET') {
      const key = url.searchParams.get('key') || '';
      try {
        const entry = readBeatMapCache(key);
        sendJSON(res, entry
          ? { ok: true, hit: true, key: entry.key || key, map: entry.map, meta: entry.meta || {}, savedAt: entry.savedAt || 0 }
          : { ok: true, hit: false, key });
      } catch (err) {
        const info = err.info || beatCacheRootInfo();
        sendJSON(res, {
          ok: false,
          hit: false,
          enabled: false,
          mode: 'memory-only',
          key,
          reason: err.code || err.message || 'BEAT_CACHE_READ_FAILED',
          dir: info.dir,
        });
      }
      return;
    }

    if (req.method === 'POST') {
      try {
        const body = await readRequestBody(req);
        sendJSON(res, writeBeatMapCache(body));
      } catch (err) {
        const info = err.info || beatCacheRootInfo();
        sendJSON(res, {
          ok: false,
          enabled: false,
          mode: 'memory-only',
          reason: err.code || err.message || 'BEAT_CACHE_WRITE_FAILED',
          dir: info.dir,
        });
      }
      return;
    }

    sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
    return;
  }

  if (pn === '/api/discover/home') {
    try {
      sendJSON(res, await handleDiscoverHome());
    } catch (err) {
      console.error('[DiscoverHome]', err);
      sendJSON(res, { error: err.message, loggedIn: false, dailySongs: [], playlists: [], podcasts: [] }, 500);
    }
    return;
  }

  if (pn === '/api/discover/extra') {
    try {
      sendJSON(res, await handleDiscoverExtra());
    } catch (err) {
      console.error('[DiscoverExtra]', err);
      sendJSON(res, { error: err.message, toplist: [], topArtists: [], newSongs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/personal/fm') {
    try {
      const body = (await personal_fm({ cookie: userCookie, timestamp: Date.now() })).body;
      const songs = (body && body.data || []).map(mapSongRecord).filter(s => s.id && s.name);
      sendJSON(res, { songs });
    } catch (err) {
      console.error('[PersonalFM]', err);
      sendJSON(res, { error: err.message, songs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/weather/radio') {
    try {
      const data = await buildWeatherRadio({
        city: url.searchParams.get('city') || url.searchParams.get('q') || '',
        lat: url.searchParams.get('lat'),
        lon: url.searchParams.get('lon'),
        timezone: url.searchParams.get('timezone') || '',
      });
      sendJSON(res, data);
    } catch (err) {
      console.error('[WeatherRadio]', err);
      sendJSON(res, {
        ok: false,
        error: err.message,
        weather: null,
        radio: { title: '天气电台', subtitle: '天气暂时没有回来，可以先听今日推荐。', seedQueries: [], songs: [] },
      }, 500);
    }
    return;
  }

  if (pn === '/api/weather/ip-location') {
    try {
      sendJSON(res, { ok: true, location: await fetchIpWeatherLocation() });
    } catch (err) {
      console.error('[WeatherIpLocation]', err);
      sendJSON(res, { ok: false, error: err.message, location: null }, 500);
    }
    return;
  }

  // ---------- 音源配置（搜索源启用/禁用 + 音源配置 增删改查）----------
  if (pn === '/api/config/sources') {
    if (req.method === 'GET') {
      sendJSON(res, musicSourceConfig || getDefaultSourceConfig());
      return;
    }
    if (req.method === 'PUT') {
      try {
        const body = await readRequestBody(req);
        const result = saveMusicSourceConfig(body);
        sendJSON(res, { ...result, config: musicSourceConfig });
      } catch (err) {
        console.error('[ConfigSave]', err);
        sendJSON(res, { ok: false, error: err.message }, 500);
      }
      return;
    }
    sendJSON(res, { error: 'METHOD_NOT_ALLOWED' }, 405);
    return;
  }

  // ---------- 应用配置管理（替代 localStorage 的服务端配置）----------
  // 获取配置元数据列表
  if (pn === '/api/app-config/meta') {
    sendJSON(res, { ok: true, meta: APP_CONFIG_META });
    return;
  }

  // 获取所有配置
  if (pn === '/api/app-config/all') {
    sendJSON(res, { ok: true, configs: readAllAppConfigs() });
    return;
  }

  // 写入单个配置项（前端拦截 localStorage.setItem 后调用）
  if (pn === '/api/app-config/item' && req.method === 'PUT') {
    try {
      const body = await readRequestBody(req);
      if (!body.key) { sendJSON(res, { ok: false, error: 'MISSING_KEY' }); return; }
      var ok = setAppConfigItem(body.key, body.value);
      sendJSON(res, { ok: ok });
    } catch (err) {
      sendJSON(res, { ok: false, error: err.message }, 500);
    }
    return;
  }

  // 删除单个配置项（前端拦截 localStorage.removeItem 后调用）
  if (pn === '/api/app-config/item' && req.method === 'DELETE') {
    try {
      const body = await readRequestBody(req);
      if (!body.key) { sendJSON(res, { ok: false, error: 'MISSING_KEY' }); return; }
      var configKey = LS_KEY_TO_CONFIG[body.key];
      if (!configKey) { sendJSON(res, { ok: false, error: 'UNKNOWN_KEY' }); return; }
      var data = readAppConfigFile(configKey) || {};
      delete data[body.key];
      writeAppConfigFile(configKey, data);
      sendJSON(res, { ok: true });
    } catch (err) {
      sendJSON(res, { ok: false, error: err.message }, 500);
    }
    return;
  }

  // 导出配置为 zip（?keys=visual,playback 指定要导出的分类）
  if (pn === '/api/app-config/export') {
    try {
      var keysParam = url.searchParams.get('keys') || '';
      var exportKeys = keysParam ? keysParam.split(',').filter(Boolean) : APP_CONFIG_META.map(function(m) { return m.key; });
      var zip = new AdmZip();
      var manifest = { _app: 'Mineradio', _version: 1, _exportTime: new Date().toISOString(), configs: [] };
      exportKeys.forEach(function(configKey) {
        var meta = APP_CONFIG_META.find(function(m) { return m.key === configKey; });
        if (!meta) return;
        var data = readAppConfigFile(configKey) || {};
        // 写入 JSON 文件到 zip
        zip.addFile(meta.file, Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
        manifest.configs.push({ key: meta.key, file: meta.file, label: meta.label, desc: meta.desc, lsKeys: meta.lsKeys });
      });
      zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
      var zipBuffer = zip.toBuffer();
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="mineradio-config-' + new Date().toISOString().slice(0,10) + '.zip"'
      });
      res.end(zipBuffer);
    } catch (err) {
      console.error('[AppConfigExport]', err);
      sendJSON(res, { ok: false, error: err.message }, 500);
    }
    return;
  }

  // 导入预览（上传 zip，返回包含的配置列表）
  if (pn === '/api/app-config/import-preview' && req.method === 'POST') {
    try {
      // 注意：readRequestBody 返回的是解析后的对象，无法处理二进制 zip 数据，
      // 因此直接读取原始请求体为 Buffer
      var zipBuf = await readRequestBodyAsBuffer(req);
      var zip = new AdmZip(zipBuf);
      var manifestFile = zip.getEntry('manifest.json');
      if (!manifestFile) { sendJSON(res, { ok: false, error: 'INVALID_ZIP' }); return; }
      var manifest = JSON.parse(manifestFile.getData().toString('utf8'));
      if (!manifest._app || manifest._app !== 'Mineradio') { sendJSON(res, { ok: false, error: 'INVALID_FORMAT' }); return; }
      // 返回包含的配置列表，供前端选择
      var configs = (manifest.configs || []).map(function(c) {
        return { key: c.key, label: c.label, desc: c.desc, lsKeys: c.lsKeys };
      });
      sendJSON(res, { ok: true, configs: configs });
    } catch (err) {
      sendJSON(res, { ok: false, error: err.message }, 500);
    }
    return;
  }

  // 导入执行（上传 zip + 选中的 keys）
  if (pn === '/api/app-config/import' && req.method === 'POST') {
    try {
      var importData = await readRequestBody(req);
      var zipBuffer = Buffer.from(importData.zipData, 'base64');
      var selectedKeys = importData.keys || [];
      var zip = new AdmZip(zipBuffer);
      var manifestFile = zip.getEntry('manifest.json');
      if (!manifestFile) { sendJSON(res, { ok: false, error: 'INVALID_ZIP' }); return; }
      var manifest = JSON.parse(manifestFile.getData().toString('utf8'));
      var imported = [];
      selectedKeys.forEach(function(configKey) {
        var meta = manifest.configs.find(function(c) { return c.key === configKey; });
        if (!meta) return;
        var entry = zip.getEntry(meta.file);
        if (!entry) return;
        var data = JSON.parse(entry.getData().toString('utf8'));
        writeAppConfigFile(configKey, data);
        imported.push(configKey);
      });
      sendJSON(res, { ok: true, imported: imported });
    } catch (err) {
      sendJSON(res, { ok: false, error: err.message }, 500);
    }
    return;
  }

  // ---------- 搜索建议 ----------
  if (pn === '/api/search/suggest') {
    try {
      const kw = String(url.searchParams.get('keywords') || '').trim();
      if (!kw) { sendJSON(res, { suggestions: [] }); return; }
      // 网易云搜索建议
      let neSongs = [];
      try {
        const r = await search_suggest({ keywords: kw, cookie: userCookie });
        neSongs = (r.body && r.body.result && r.body.result.songs) || [];
      } catch (e) { console.warn('[Suggest] netease failed:', e.message); }
      // 提取歌名作为建议词
      const seen = new Set();
      const suggestions = [];
      neSongs.forEach(s => {
        const name = s.name && s.name.trim();
        if (name && !seen.has(name.toLowerCase())) {
          seen.add(name.toLowerCase());
          suggestions.push(name);
        }
      });
      sendJSON(res, { suggestions: suggestions.slice(0, 8) });
    } catch (err) {
      console.error('[Suggest]', err);
      sendJSON(res, { suggestions: [] }, 500);
    }
    return;
  }

  // ---------- 热搜榜 ----------
  if (pn === '/api/search/hot') {
    try {
      const r = await search_hot_detail({ cookie: userCookie, timestamp: Date.now() });
      const list = (r.body && r.body.data) || [];
      const hot = list.map(item => ({
        keyword: item.searchWord,
        score: item.score || 0,
        icon: item.iconUrl || '',
        desc: item.content || ''
      })).slice(0, 20);
      sendJSON(res, { hot });
    } catch (err) {
      console.error('[HotSearch]', err);
      sendJSON(res, { hot: [] }, 500);
    }
    return;
  }

  // ---------- 搜索 ----------
  if (pn === '/api/search') {
    try {
      const kw    = url.searchParams.get('keywords') || '';
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const type  = parseInt(url.searchParams.get('type') || '1');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const songs = await handleSearch(kw, limit, type, offset);
      sendJSON(res, { songs });
    } catch (err) { console.error('[Search]', err); sendJSON(res, { error: err.message, songs: [] }, 500); }
    return;
  }

  if (pn === '/api/qq/search') {
    try {
      const kw = url.searchParams.get('keywords') || '';
      const limit = Math.max(4, Math.min(12, parseInt(url.searchParams.get('limit') || '8', 10) || 8));
      const songs = await handleQQSearch(kw, limit);
      sendJSON(res, { provider: 'qq', songs });
    } catch (err) {
      console.error('[QQSearch]', err);
      sendJSON(res, { provider: 'qq', error: err.message, songs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/search') {
    try {
      const kw = url.searchParams.get('keywords') || '';
      const limit = Math.max(4, Math.min(30, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const songs = await handleKugouSearch(kw, limit, offset);
      sendJSON(res, { provider: 'kugou', songs });
    } catch (err) {
      console.error('[KugouSearch]', err);
      sendJSON(res, { provider: 'kugou', error: err.message, songs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/song/url') {
    try {
      const hash = url.searchParams.get('hash') || url.searchParams.get('id') || '';
      const info = await handleKugouSongUrl(hash);
      sendJSON(res, info);
    } catch (err) {
      console.error('[KugouSongUrl]', err);
      sendJSON(res, { provider: 'kugou', url: '', error: err.message, playable: false }, 500);
    }
    return;
  }

  if (pn === '/api/kuwo/search') {
    try {
      const kw = url.searchParams.get('keywords') || '';
      const limit = Math.max(4, Math.min(30, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const songs = await handleKuwoSearch(kw, limit, offset);
      sendJSON(res, { provider: 'kuwo', songs });
    } catch (err) {
      console.error('[KuwoSearch]', err);
      sendJSON(res, { provider: 'kuwo', error: err.message, songs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/kuwo/song/url') {
    try {
      const rid = url.searchParams.get('rid') || url.searchParams.get('id') || '';
      const quality = url.searchParams.get('quality') || '';
      const info = await handleKuwoSongUrl(rid, quality);
      sendJSON(res, info);
    } catch (err) {
      console.error('[KuwoSongUrl]', err);
      sendJSON(res, { provider: 'kuwo', url: '', error: err.message, playable: false }, 500);
    }
    return;
  }

  if (pn === '/api/migu/search') {
    try {
      const kw = url.searchParams.get('keywords') || '';
      const limit = Math.max(4, Math.min(30, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const songs = await handleMiguSearch(kw, limit, offset);
      sendJSON(res, { provider: 'migu', songs });
    } catch (err) {
      console.error('[MiguSearch]', err);
      sendJSON(res, { provider: 'migu', error: err.message, songs: [] }, 500);
    }
    return;
  }

  // ========== 下载路由 ==========
  if (pn === '/api/download/start' && req.method === 'POST') {
    let body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', async function() {
      try {
        var parsed = JSON.parse(body);
        var provider = parsed.provider || 'netease';
        var songData = parsed.songData || {};
        var quality = parsed.quality || 'exhigh';
        var taskId = downloadTaskIdCounter++;
        var task = {
          id: taskId,
          status: 'pending',
          songName: songData.name || '',
          artist: songData.artist || '',
          provider: provider,
          quality: quality,
          songData: songData,
          totalBytes: 0,
          downloadedBytes: 0,
          filePath: '',
          error: null,
          createdAt: Date.now(),
        };
        downloadTasks.set(taskId, task);
        persistDownloadTasksDebounced();
        sendJSON(res, { ok: true, taskId: taskId });
        // 异步开始下载
        startDownloadTask(taskId, songData, quality, provider);
      } catch (err) {
        sendJSON(res, { ok: false, error: err.message }, 500);
      }
    });
    return;
  }

  if (pn === '/api/download/list') {
    var list = Array.from(downloadTasks.values()).map(serializeDownloadTask).sort(function(a, b) { return b.createdAt - a.createdAt; });
    sendJSON(res, { tasks: list });
    return;
  }

  if (pn === '/api/download/cancel' && req.method === 'POST') {
    let body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var parsed = JSON.parse(body);
        var task = downloadTasks.get(parsed.taskId);
        if (task) {
          task.status = 'cancelled';
          if (task.controller) task.controller.abort();
          if (task.filePath) { try { fs.unlinkSync(task.filePath); } catch (e) {} }
          persistDownloadTasksDebounced();
        }
        sendJSON(res, { ok: true });
      } catch (err) {
        sendJSON(res, { ok: false, error: err.message }, 500);
      }
    });
    return;
  }

  if (pn === '/api/download/clear' && req.method === 'POST') {
    for (var entry of downloadTasks) {
      if (['completed', 'failed', 'cancelled'].includes(entry[1].status)) {
        downloadTasks.delete(entry[0]);
      }
    }
    persistDownloadTasksDebounced();
    sendJSON(res, { ok: true });
    return;
  }

  // 暂停单个任务
  if (pn === '/api/download/pause' && req.method === 'POST') {
    let body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var parsed = JSON.parse(body);
        var task = downloadTasks.get(parsed.taskId);
        if (task && (task.status === 'pending' || task.status === 'downloading')) {
          task.status = 'paused';
          if (task.controller) { try { task.controller.abort(); } catch (e) {} task.controller = null; }
          persistDownloadTasksDebounced();
        }
        sendJSON(res, { ok: true });
      } catch (err) {
        sendJSON(res, { ok: false, error: err.message }, 500);
      }
    });
    return;
  }

  // 继续单个任务（重新下载）
  if (pn === '/api/download/resume' && req.method === 'POST') {
    let body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var parsed = JSON.parse(body);
        var task = downloadTasks.get(parsed.taskId);
        if (task && task.status === 'paused' && task.songData) {
          task.status = 'pending';
          task.downloadedBytes = 0;
          task.totalBytes = 0;
          task.error = null;
          persistDownloadTasksDebounced();
          startDownloadTask(task.id, task.songData, task.quality, task.provider);
        }
        sendJSON(res, { ok: true });
      } catch (err) {
        sendJSON(res, { ok: false, error: err.message }, 500);
      }
    });
    return;
  }

  // 暂停全部下载中任务
  if (pn === '/api/download/pause-all' && req.method === 'POST') {
    downloadTasks.forEach(function(task) {
      if (task.status === 'pending' || task.status === 'downloading') {
        task.status = 'paused';
        if (task.controller) { try { task.controller.abort(); } catch (e) {} task.controller = null; }
      }
    });
    persistDownloadTasksDebounced();
    sendJSON(res, { ok: true });
    return;
  }

  // 继续全部已暂停任务
  if (pn === '/api/download/resume-all' && req.method === 'POST') {
    downloadTasks.forEach(function(task) {
      if (task.status === 'paused' && task.songData) {
        task.status = 'pending';
        task.downloadedBytes = 0;
        task.totalBytes = 0;
        task.error = null;
        startDownloadTask(task.id, task.songData, task.quality, task.provider);
      }
    });
    persistDownloadTasksDebounced();
    sendJSON(res, { ok: true });
    return;
  }

  if (pn === '/api/download/open-folder' && req.method === 'POST') {
    var dir = ensureDownloadDir();
    try {
      var childExec = require('child_process').exec;
      if (process.platform === 'win32') {
        childExec('explorer "' + dir + '"');
      } else if (process.platform === 'darwin') {
        childExec('open "' + dir + '"');
      } else {
        childExec('xdg-open "' + dir + '"');
      }
      sendJSON(res, { ok: true, dir: dir });
    } catch (err) {
      sendJSON(res, { ok: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/download/config') {
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', function(chunk) { body += chunk; });
      req.on('end', function() {
        try {
          var parsed = JSON.parse(body);
          var newDir = parsed.downloadDir;
          if (newDir && typeof newDir === 'string') {
            if (!musicSourceConfig) loadMusicSourceConfig();
            musicSourceConfig.downloadDir = newDir;
            saveMusicSourceConfig(musicSourceConfig);
            sendJSON(res, { ok: true, downloadDir: newDir });
          } else {
            sendJSON(res, { ok: false, error: 'invalid downloadDir' }, 400);
          }
        } catch (err) {
          sendJSON(res, { ok: false, error: err.message }, 500);
        }
      });
      return;
    }
    sendJSON(res, { downloadDir: getDownloadDir() });
    return;
  }

  // Wallpaper Engine 壁纸列表
  if (pn === '/api/we-wallpapers/list') {
    try {
      const list = await scanWallpaperEngineWallpapers();
      sendJSON(res, { ok: true, count: list.length, wallpapers: list.map(w => ({
        id: w.id,
        title: w.title,
        type: w.type,
        hasVideo: !!w.video,
        hasPreview: !!w.preview,
        workshopId: w.workshopId,
      })) });
    } catch (e) {
      sendJSON(res, { ok: false, error: e.message }, 500);
    }
    return;
  }

  // Wallpaper Engine 预览图
  if (pn.startsWith('/api/we-wallpapers/preview/')) {
    const id = decodeURIComponent(pn.slice('/api/we-wallpapers/preview/'.length));
    const list = await scanWallpaperEngineWallpapers();
    const wp = list.find(w => w.id === id);
    if (!wp || !wp.preview) { res.statusCode = 404; res.end('Not Found'); return; }
    try {
      const stat = fs.statSync(wp.preview);
      const ext = path.extname(wp.preview).toLowerCase();
      const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
      const contentType = mimeMap[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(wp.preview).pipe(res);
    } catch (e) {
      res.statusCode = 500; res.end(e.message);
    }
    return;
  }

  // Wallpaper Engine 视频
  if (pn.startsWith('/api/we-wallpapers/video/')) {
    const id = decodeURIComponent(pn.slice('/api/we-wallpapers/video/'.length));
    const list = await scanWallpaperEngineWallpapers();
    const wp = list.find(w => w.id === id);
    if (!wp || !wp.video) { res.statusCode = 404; res.end('Not Found'); return; }
    try {
      const stat = fs.statSync(wp.video);
      const ext = path.extname(wp.video).toLowerCase();
      const mimeMap = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
      const contentType = mimeMap[ext] || 'video/mp4';
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10) || 0;
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunkSize = (end - start) + 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': contentType,
        });
        fs.createReadStream(wp.video, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
        fs.createReadStream(wp.video).pipe(res);
      }
    } catch (e) {
      res.statusCode = 500; res.end(e.message);
    }
    return;
  }

  if (pn === '/api/qq/song/url') {
    try {
      const mid = url.searchParams.get('mid') || url.searchParams.get('id') || '';
      const mediaMid = url.searchParams.get('mediaMid') || url.searchParams.get('media_mid') || '';
      const quality = url.searchParams.get('quality') || '';
      const info = await handleQQSongUrl(mid, mediaMid, quality);
      sendJSON(res, info);
    } catch (err) {
      console.error('[QQSongUrl]', err);
      sendJSON(res, { provider: 'qq', url: '', playable: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/qq/lyric') {
    try {
      const mid = url.searchParams.get('mid') || url.searchParams.get('songmid') || '';
      const id = url.searchParams.get('id') || url.searchParams.get('qqId') || '';
      if (!mid && !id) { sendJSON(res, { provider: 'qq', error: 'Missing QQ song mid or id', lyric: '' }, 400); return; }
      const data = await handleQQLyric(mid, id);
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQLyric]', err);
      sendJSON(res, { provider: 'qq', error: err.message, lyric: '' }, 500);
    }
    return;
  }

  // ---------- 歌曲URL ----------
  if (pn === '/api/qq/login/status') {
    try {
      const info = await getQQLoginInfo();
      sendJSON(res, info);
    } catch (err) {
      console.error('[QQLoginStatus]', err);
      sendJSON(res, { provider: 'qq', loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/qq/login/cookie') {
    try {
      const body = await readRequestBody(req);
      const raw = body.cookie || body.data || body.text || '';
      const normalized = normalizeQQCookieInput(raw);
      const obj = parseCookieString(normalized);
      if (!qqCookieUin(obj) || !qqCookieMusicKey(obj)) {
        sendJSON(res, { provider: 'qq', loggedIn: false, error: 'INVALID_QQ_COOKIE', message: 'QQ cookie 缺少 uin 或有效登录票据' }, 400);
        return;
      }
      saveQQCookie(normalized);
      const info = await getQQLoginInfo();
      sendJSON(res, { ...info, saved: true });
    } catch (err) {
      console.error('[QQLoginCookie]', err);
      sendJSON(res, { provider: 'qq', loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/qq/logout') {
    saveQQCookie('');
    sendJSON(res, { provider: 'qq', ok: true, loggedIn: false });
    return;
  }

  if (pn === '/api/qq/user/playlists') {
    try {
      const data = await handleQQUserPlaylists();
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQUserPlaylists]', err);
      sendJSON(res, { provider: 'qq', loggedIn: false, error: err.message, playlists: [] }, 500);
    }
    return;
  }

  if (pn === '/api/qq/playlist/tracks') {
    try {
      const id = url.searchParams.get('id') || url.searchParams.get('disstid') || '';
      const data = await handleQQPlaylistTracks(id);
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQPlaylistTracks]', err);
      sendJSON(res, { provider: 'qq', error: err.message, tracks: [] }, 500);
    }
    return;
  }

  if (pn === '/api/qq/artist/detail') {
    try {
      const mid = url.searchParams.get('mid') || url.searchParams.get('singermid') || '';
      const limit = Math.max(10, Math.min(80, parseInt(url.searchParams.get('limit') || '36', 10) || 36));
      if (!mid) {
        sendJSON(res, { provider: 'qq', error: 'MISSING_SINGER_MID', artist: null, songs: [] }, 400);
        return;
      }
      const data = await handleQQArtistDetail(mid, limit);
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQArtistDetail]', err);
      sendJSON(res, { provider: 'qq', error: err.message, artist: null, songs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/qq/song/comments') {
    try {
      const id = url.searchParams.get('id') || url.searchParams.get('qqId') || '';
      const mid = url.searchParams.get('mid') || url.searchParams.get('songmid') || '';
      const limit = Math.max(6, Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const data = await handleQQSongComments(id, mid, limit, offset);
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQSongComments]', err);
      sendJSON(res, { provider: 'qq', error: err.message, comments: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/search') {
    try {
      const kw = String(url.searchParams.get('keywords') || '').trim();
      const limit = Math.max(6, Math.min(30, parseInt(url.searchParams.get('limit') || '18', 10) || 18));
      if (!kw) { sendJSON(res, { podcasts: [] }); return; }
      const r = await cloudsearch({ keywords: kw, type: 1009, limit, cookie: userCookie, timestamp: Date.now() });
      const result = (r.body && r.body.result) || {};
      const raw = result.djRadios || result.djradios || result.radios || [];
      const podcasts = raw.map(mapPodcastRadio).filter(p => p.id);
      sendJSON(res, { podcasts, total: result.djRadiosCount || result.djradiosCount || podcasts.length });
    } catch (err) {
      console.error('[PodcastSearch]', err);
      sendJSON(res, { error: err.message, podcasts: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/hot') {
    try {
      const limit = Math.max(6, Math.min(30, parseInt(url.searchParams.get('limit') || '18', 10) || 18));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const r = await dj_hot({ limit, offset, cookie: userCookie, timestamp: Date.now() });
      const body = r.body || {};
      const raw = body.djRadios || body.djradios || body.radios || body.data || [];
      const podcasts = (Array.isArray(raw) ? raw : []).map(mapPodcastRadio).filter(p => p.id);
      sendJSON(res, { podcasts, more: !!body.hasMore });
    } catch (err) {
      console.error('[PodcastHot]', err);
      sendJSON(res, { error: err.message, podcasts: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/detail') {
    try {
      const rid = url.searchParams.get('id') || url.searchParams.get('rid');
      if (!rid) { sendJSON(res, { error: 'Missing podcast id' }, 400); return; }
      const r = await dj_detail({ rid, cookie: userCookie, timestamp: Date.now() });
      const body = r.body || {};
      const radio = mapPodcastRadio(body.data || body.djRadio || body.radio || body);
      sendJSON(res, { podcast: radio });
    } catch (err) {
      console.error('[PodcastDetail]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/programs') {
    try {
      const rid = url.searchParams.get('id') || url.searchParams.get('rid');
      if (!rid) { sendJSON(res, { error: 'Missing podcast id', programs: [] }, 400); return; }
      const limit = Math.max(10, Math.min(60, parseInt(url.searchParams.get('limit') || '30', 10) || 30));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const r = await dj_program({ rid, limit, offset, asc: false, cookie: userCookie, timestamp: Date.now() });
      const body = r.body || {};
      const raw = body.programs || (body.data && (body.data.list || body.data.programs)) || [];
      const radio = raw[0] && raw[0].radio ? mapPodcastRadio(raw[0].radio) : { id: rid, rid };
      const programs = (Array.isArray(raw) ? raw : [])
        .map(p => mapPodcastProgram(p, radio))
        .filter(p => p.id && p.name);
      sendJSON(res, { radio, programs, more: !!body.more, total: body.count || programs.length });
    } catch (err) {
      console.error('[PodcastPrograms]', err);
      sendJSON(res, { error: err.message, programs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/my') {
    try {
      const info = await getLoginInfo();
      if (!info.loggedIn || !info.userId) {
        const empty = ['collect', 'created', 'liked'].map(k => podcastCollectionMeta(k, []));
        sendJSON(res, { loggedIn: false, collections: empty });
        return;
      }
      const keys = ['collect', 'created', 'liked'];
      const collections = await Promise.all(keys.map(async key => {
        try {
          const data = await fetchMyPodcastItems(key, info, 12, 0);
          return podcastCollectionMeta(key, data.items || []);
        } catch (e) {
          console.warn('[MyPodcast]', key, e.message);
          return podcastCollectionMeta(key, []);
        }
      }));
      sendJSON(res, { loggedIn: true, collections });
    } catch (err) {
      console.error('[MyPodcast]', err);
      sendJSON(res, { error: err.message, collections: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/my/items') {
    try {
      const info = await getLoginInfo();
      if (!info.loggedIn || !info.userId) { sendJSON(res, { loggedIn: false, items: [] }); return; }
      const key = String(url.searchParams.get('key') || 'collect');
      const limit = parseInt(url.searchParams.get('limit') || '36', 10) || 36;
      const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
      const data = await fetchMyPodcastItems(key, info, limit, offset);
      sendJSON(res, { loggedIn: true, key, ...podcastCollectionMeta(key, data.items || []), itemType: data.itemType, items: data.items || [] });
    } catch (err) {
      console.error('[MyPodcastItems]', err);
      sendJSON(res, { error: err.message, items: [] }, 500);
    }
    return;
  }

  if (pn === '/api/song/url') {
    try {
      const sid = url.searchParams.get('id');
      const quality = url.searchParams.get('quality') || '';
      const loginInfo = await getLoginInfo();
      const info = await handleSongUrl(sid, loginInfo, quality);
      sendJSON(res, {
        ...info,
        loggedIn: loginInfo.loggedIn,
        vipType: loginInfo.vipType || 0,
        vipLevel: loginInfo.vipLevel || 'none',
        isVip: !!loginInfo.isVip,
        isSvip: !!loginInfo.isSvip,
        vipLabel: loginInfo.vipLabel || '无VIP',
      });
    } catch (err) { console.error('[SongUrl]', err); sendJSON(res, { error: err.message }, 500); }
    return;
  }

  if (pn === '/api/login/cookie') {
    try {
      const body = await readRequestBody(req);
      const raw = body.cookie || body.data || body.text || '';
      const normalized = normalizeCookieHeader(raw);
      const obj = parseCookieString(normalized);
      if (!obj.MUSIC_U) {
        sendJSON(res, { loggedIn: false, error: 'INVALID_NETEASE_COOKIE', message: '网易云 cookie 缺少 MUSIC_U' }, 400);
        return;
      }
      saveCookie(normalized);
      let info = await getLoginInfo();
      if (!info.loggedIn && userCookie) {
        info = {
          loggedIn: true,
          pendingProfile: true,
          nickname: '网易云用户',
          avatar: '',
          vipType: 0,
          vipLevel: 'none',
          isVip: false,
          isSvip: false,
          vipLabel: '无VIP',
        };
      }
      sendJSON(res, { ...info, saved: true, hasCookie: !!userCookie });
    } catch (err) {
      console.error('[LoginCookie]', err);
      sendJSON(res, { loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  // ---------- 登录: QR Key ----------
  // ---------- 播客 DJ 长音频后端离线锁拍 ----------
  if (pn === '/api/podcast/dj-beatmap') {
    try {
      const audioUrl = url.searchParams.get('url');
      const durationSec = Math.max(0, Number(url.searchParams.get('duration') || 0) || 0);
      if (!audioUrl || !/^https?:\/\//i.test(audioUrl)) {
        sendJSON(res, { error: 'Invalid audio url' }, 400);
        return;
      }
      console.log('[PodcastDjBeatmap] start', Math.round(durationSec || 0) + 's');
      const started = Date.now();
      const introSec = Math.max(0, Number(url.searchParams.get('intro') || 0) || 0);
      const map = introSec
        ? await analyzePodcastDjIntro(audioUrl, { durationSec, introSec, userAgent: UA })
        : await analyzePodcastDjStream(audioUrl, { durationSec, userAgent: UA });
      console.log('[PodcastDjBeatmap] done beats:', map.visualBeatCount || 0, 'ms:', Date.now() - started, 'decode:', map.decode || {});
      sendJSON(res, { ok: true, map });
    } catch (err) {
      console.error('[PodcastDjBeatmap]', err);
      sendJSON(res, { ok: false, error: err.message || String(err) }, 500);
    }
    return;
  }

  if (pn === '/api/login/qr/key') {
    try {
      const r = await login_qr_key({ timestamp: Date.now() });
      const key = r.body && r.body.data && r.body.data.unikey;
      sendJSON(res, { key });
    } catch (err) { sendJSON(res, { error: err.message }, 500); }
    return;
  }

  // ---------- 登录: QR 二维码图片 ----------
  if (pn === '/api/login/qr/create') {
    try {
      const key = url.searchParams.get('key');
      const r = await login_qr_create({ key, qrimg: true, timestamp: Date.now() });
      const d = r.body && r.body.data;
      sendJSON(res, { img: d && d.qrimg, url: d && d.qrurl });
    } catch (err) { sendJSON(res, { error: err.message }, 500); }
    return;
  }

  // ---------- 登录: 轮询扫码状态 ----------
  if (pn === '/api/login/qr/check') {
    try {
      const key = url.searchParams.get('key');
      let r = await login_qr_check({ key, noCookie: true, timestamp: Date.now() });
      let body = r.body || {};
      let code = Number(body.code || r.code);
      let msg  = body.message || r.message || '';
      let cookie = readCookieFromResponse(r);
      if (code === 803 && !cookie) {
        try {
          const retry = await login_qr_check({ key, timestamp: Date.now() });
          const retryCookie = readCookieFromResponse(retry);
          if (retryCookie) {
            r = retry;
            body = retry.body || body;
            code = Number(body.code || retry.code || code);
            msg = body.message || retry.message || msg;
            cookie = retryCookie;
          }
        } catch (retryErr) {
          console.warn('[Login] qr cookie retry failed:', retryErr.message);
        }
      }
      // 803 = 授权成功, 802 = 已扫待确认, 801 = 等待扫码, 800 = 二维码过期
      if (code === 803) {
        if (cookie) saveCookie(cookie);
        let info = await getLoginInfo();
        if (!info.loggedIn) {
          const profile = body.profile || (body.data && body.data.profile) || {};
          info = normalizeLoginInfo(profile, body.account || (body.data && body.data.account), body.data || body);
        }
        if (!info.loggedIn && cookie) {
          info = {
            loggedIn: true,
            pendingProfile: true,
            nickname: (body.nickname || (body.profile && body.profile.nickname) || '网易云用户'),
            avatar: body.avatarUrl || (body.profile && body.profile.avatarUrl) || '',
            vipType: 0,
            vipLevel: 'none',
            isVip: false,
            isSvip: false,
            vipLabel: '无VIP',
          };
        }
        sendJSON(res, { code, message: msg, ...info, hasCookie: !!cookie });
        return;
      }
      sendJSON(res, { code, message: msg, nickname: body.nickname, avatar: body.avatarUrl });
    } catch (err) { sendJSON(res, { error: err.message }, 500); }
    return;
  }

  // ---------- 登录态查询 ----------
  if (pn === '/api/login/status') {
    const info = await getLoginInfo();
    sendJSON(res, info);
    return;
  }

  // ---------- 登出 ----------
  if (pn === '/api/logout') {
    try { await logout({ cookie: userCookie }); } catch (e) {}
    saveCookie('');
    sendJSON(res, { ok: true });
    return;
  }

  // ---------- 用户歌单 ----------
  if (pn === '/api/user/playlists') {
    try {
      const info = await getLoginInfo();
      if (!info.loggedIn || !info.userId) { sendJSON(res, { loggedIn: false, playlists: [] }); return; }
      const limit = Math.max(12, Math.min(100, parseInt(url.searchParams.get('limit') || '60', 10) || 60));
      const r = await user_playlist({ uid: info.userId, limit, cookie: userCookie, timestamp: Date.now() });
      const list = ((r.body && r.body.playlist) || []).map(pl => ({
        id: pl.id,
        name: pl.name,
        cover: pl.coverImgUrl || '',
        trackCount: pl.trackCount || 0,
        playCount: pl.playCount || 0,
        creator: (pl.creator && pl.creator.nickname) || '',
        subscribed: !!pl.subscribed,
        specialType: pl.specialType || 0,
      }));
      sendJSON(res, { loggedIn: true, userId: info.userId, playlists: list });
    } catch (err) {
      console.error('[UserPlaylists]', err);
      sendJSON(res, { error: err.message, loggedIn: false, playlists: [] }, 500);
    }
    return;
  }

  // ---------- 红心状态 ----------
  if (pn === '/api/song/like/check') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const ids = String(url.searchParams.get('ids') || url.searchParams.get('id') || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      if (!ids.length) { sendJSON(res, { error: 'Missing song id', liked: {}, ids: [] }, 400); return; }
      let likedIds = [];
      try {
        if (typeof song_like_check === 'function') {
          const checked = await song_like_check({ ids: JSON.stringify(ids.map(Number).filter(Boolean)), cookie: userCookie, timestamp: Date.now() });
          const data = (checked.body && (checked.body.data || checked.body.ids)) || checked.body || {};
          if (Array.isArray(data)) likedIds = data.map(String);
          else if (data && typeof data === 'object') {
            ids.forEach(id => {
              if (data[id] || data[String(id)] || data[Number(id)]) likedIds.push(String(id));
            });
          }
        }
      } catch (e) {
        console.warn('[LikeCheck] direct check failed:', e.message);
      }
      if (!likedIds.length) {
        const r = await likelist({ uid: info.userId, cookie: userCookie, timestamp: Date.now() });
        likedIds = ((r.body && r.body.ids) || []).map(String);
      }
      const set = new Set(likedIds);
      const liked = {};
      ids.forEach(id => { liked[id] = set.has(String(id)); });
      sendJSON(res, { loggedIn: true, ids, liked });
    } catch (err) {
      console.error('[LikeCheck]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 红心/取消红心 ----------
  if (pn === '/api/song/like') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const id = body.id || url.searchParams.get('id');
      const nextLike = String(body.like != null ? body.like : (url.searchParams.get('like') || 'true')) !== 'false';
      if (!id) { sendJSON(res, { error: 'Missing song id' }, 400); return; }
      const r = await like_song({ id, like: String(nextLike), cookie: userCookie, timestamp: Date.now() });
      const code = (r.body && r.body.code) || r.code || 200;
      sendJSON(res, { loggedIn: true, id, liked: nextLike, code, body: r.body || r });
    } catch (err) {
      console.error('[Like]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 创建歌单 ----------
  if (pn === '/api/playlist/create') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const name = String(body.name || url.searchParams.get('name') || '').trim();
      const privacy = String(body.privacy || url.searchParams.get('privacy') || '0');
      if (!name) { sendJSON(res, { error: 'Missing playlist name' }, 400); return; }
      const r = await playlist_create({ name, privacy, cookie: userCookie, timestamp: Date.now() });
      const created = (r.body && (r.body.playlist || r.body.data)) || {};
      sendJSON(res, { loggedIn: true, playlist: created, body: r.body || r });
    } catch (err) {
      console.error('[PlaylistCreate]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 收藏歌曲到歌单 ----------
  if (pn === '/api/playlist/add-song') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const pid = body.pid || url.searchParams.get('pid');
      const id = body.id || body.ids || url.searchParams.get('id') || url.searchParams.get('ids');
      if (!pid || !id) { sendJSON(res, { error: 'Missing playlist id or song id' }, 400); return; }
      const attempts = [];
      let finalBody = null;
      let finalCode = 0;
      let finalMessage = '';
      let success = false;

      const primary = await playlist_tracks({ op: 'add', pid, tracks: String(id), cookie: userCookie, timestamp: Date.now() });
      finalBody = primary.body || primary;
      finalCode = normalizeApiCode(primary);
      finalMessage = normalizeApiMessage(primary);
      success = finalCode === 200 && !(finalBody && finalBody.error);
      attempts.push({ api: 'playlist_tracks', code: finalCode, message: finalMessage, body: finalBody });

      if (!success && typeof playlist_track_add === 'function') {
        try {
          const fallback = await playlist_track_add({ pid, ids: String(id), cookie: userCookie, timestamp: Date.now() });
          finalBody = fallback.body || fallback;
          finalCode = normalizeApiCode(fallback);
          finalMessage = normalizeApiMessage(fallback);
          success = finalCode === 200 && !(finalBody && finalBody.error);
          attempts.push({ api: 'playlist_track_add', code: finalCode, message: finalMessage, body: finalBody });
        } catch (fallbackErr) {
          const errBody = fallbackErr.body || fallbackErr.response || {};
          finalBody = errBody;
          finalCode = normalizeApiCode(errBody);
          finalMessage = normalizeApiMessage(errBody) || fallbackErr.message || '';
          attempts.push({ api: 'playlist_track_add', code: finalCode, message: finalMessage, body: errBody });
        }
      }

      if (!success) {
        sendJSON(res, { loggedIn: true, pid, id, success: false, code: finalCode, error: finalMessage || 'PLAYLIST_ADD_FAILED', attempts }, finalCode === 401 ? 401 : 409);
        return;
      }
      sendJSON(res, { loggedIn: true, pid, id, success: true, code: finalCode, body: finalBody, attempts });
    } catch (err) {
      console.error('[PlaylistAddSong]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 歌词 ----------
  if (pn === '/api/lyric') {
    try {
      const id = url.searchParams.get('id');
      if (!id) { sendJSON(res, { error: 'Missing song id', lyric: '' }, 400); return; }
      let body = {};
      let source = 'lyric';
      try {
        if (typeof lyric_new === 'function') {
          const nr = await lyric_new({ id, cookie: userCookie, timestamp: Date.now() });
          body = nr.body || {};
          source = 'lyric_new';
        }
      } catch (errNew) {
        console.warn('[LyricNew]', errNew.message);
      }
      if (!((body.lrc && body.lrc.lyric) || (body.yrc && body.yrc.lyric))) {
        const r = await lyric({ id, cookie: userCookie, timestamp: Date.now() });
        body = r.body || body || {};
        source = 'lyric';
      }
      sendJSON(res, {
        lyric: (body.lrc && body.lrc.lyric) || '',
        tlyric: (body.tlyric && body.tlyric.lyric) || '',
        yrc: (body.yrc && body.yrc.lyric) || '',
        source,
      });
    } catch (err) {
      console.error('[Lyric]', err);
      sendJSON(res, { error: err.message, lyric: '' }, 500);
    }
    return;
  }

  // ---------- 歌曲评论 ----------
  if (pn === '/api/song/comments') {
    try {
      const id = url.searchParams.get('id');
      const limit = Math.max(6, Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      if (!id) { sendJSON(res, { error: 'Missing song id', comments: [] }, 400); return; }
      const r = await comment_music({ id, limit, offset, cookie: userCookie, timestamp: Date.now() });
      const body = r.body || r || {};
      const raw = body.hotComments && offset === 0 ? body.hotComments : (body.comments || []);
      const comments = (raw || []).map(c => ({
        id: c.commentId,
        content: c.content || '',
        likedCount: c.likedCount || 0,
        time: c.time || 0,
        user: c.user ? { id: c.user.userId, nickname: c.user.nickname || '', avatar: c.user.avatarUrl || '' } : null,
      })).filter(c => c.content);
      sendJSON(res, { id, total: body.total || 0, comments, hot: !!(body.hotComments && offset === 0), body });
    } catch (err) {
      console.error('[SongComments]', err);
      sendJSON(res, { error: err.message, comments: [] }, 500);
    }
    return;
  }

  // ---------- 歌手主页 / 热门歌曲 ----------
  if (pn === '/api/artist/detail') {
    try {
      const id = url.searchParams.get('id');
      const limit = Math.max(10, Math.min(80, parseInt(url.searchParams.get('limit') || '30', 10) || 30));
      if (!id) { sendJSON(res, { error: 'Missing artist id', songs: [] }, 400); return; }
      let detailBody = {};
      try {
        const detail = await artist_detail({ id, cookie: userCookie, timestamp: Date.now() });
        detailBody = detail.body || detail || {};
      } catch (e) {
        console.warn('[ArtistDetail] detail failed:', e.message);
      }
      let rawSongs = [];
      try {
        const list = await artist_songs({ id, order: 'hot', limit, offset: 0, cookie: userCookie, timestamp: Date.now() });
        const b = list.body || list || {};
        rawSongs = (b.songs || (b.data && b.data.songs) || []);
      } catch (e) {
        console.warn('[ArtistSongs] hot failed:', e.message);
      }
      if (!rawSongs.length) {
        const top = await artist_top_song({ id, cookie: userCookie, timestamp: Date.now() });
        const b = top.body || top || {};
        rawSongs = b.songs || [];
      }
      const artist = detailBody.artist || (detailBody.data && (detailBody.data.artist || detailBody.data)) || {};
      const songs = rawSongs.map(mapSongRecord).filter(s => s.id).slice(0, limit);
      sendJSON(res, {
        id,
        artist: {
          id: artist.id || id,
          name: artist.name || artist.artistName || '',
          avatar: artist.avatar || artist.cover || artist.picUrl || artist.img1v1Url || '',
          brief: artist.briefDesc || artist.description || artist.desc || '',
          musicSize: artist.musicSize || artist.songSize || 0,
          albumSize: artist.albumSize || 0,
        },
        songs,
        body: detailBody,
      });
    } catch (err) {
      console.error('[ArtistDetail]', err);
      sendJSON(res, { error: err.message, songs: [] }, 500);
    }
    return;
  }

  // ---------- 歌单曲目详情 ----------
  if (pn === '/api/playlist/tracks') {
    try {
      const id = url.searchParams.get('id');
      if (!id) { sendJSON(res, { error: 'Missing playlist id', tracks: [] }, 400); return; }

      let playlistMeta = { id, name: '', cover: '', trackCount: 0 };
      let rawTracks = [];

      // 新版本 NeteaseCloudMusicApi 通常提供 playlist_track_all；旧版本退回 playlist_detail。
      if (typeof playlist_track_all === 'function') {
        try {
          const all = await playlist_track_all({ id, limit: 500, offset: 0, cookie: userCookie, timestamp: Date.now() });
          rawTracks = (all.body && (all.body.songs || all.body.tracks)) || [];
        } catch (err) {
          console.warn('[PlaylistTracks] playlist_track_all failed, fallback to detail:', err.message);
        }
      }

      if (!rawTracks.length && typeof playlist_detail === 'function') {
        const detail = await playlist_detail({ id, s: 0, cookie: userCookie, timestamp: Date.now() });
        const pl = (detail.body && detail.body.playlist) || {};
        playlistMeta = { id: pl.id || id, name: pl.name || '', cover: pl.coverImgUrl || '', trackCount: pl.trackCount || 0 };
        rawTracks = pl.tracks || [];
      }

      const tracks = rawTracks.map(mapSongRecord).filter(t => t.id);

      if (!playlistMeta.trackCount) playlistMeta.trackCount = tracks.length;
      sendJSON(res, { playlist: playlistMeta, tracks });
    } catch (err) {
      console.error('[PlaylistTracks]', err);
      sendJSON(res, { error: err.message, tracks: [] }, 500);
    }
    return;
  }

  // ---------- 封面代理 (带 CORS 头, 给 canvas 提取像素用) ----------
  if (pn === '/api/cover') {
    try {
      const coverUrl = url.searchParams.get('url');
      // URL 校验: 必须是 http(s) 开头, 否则直接 404 (不要让 fetch 抛错)
      if (!coverUrl || !/^https?:\/\//i.test(coverUrl)) {
        res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
        res.end('Invalid cover url');
        return;
      }
      const resp = await fetch(coverUrl, { headers: { 'User-Agent': UA, 'Referer': 'https://music.163.com/' } });
      const ct  = resp.headers.get('content-type') || 'image/jpeg';
      const cl  = resp.headers.get('content-length');
      const hdr = {
        'Content-Type': ct,
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Cache-Control': 'public, max-age=86400',
      };
      if (cl) hdr['Content-Length'] = cl;
      res.writeHead(resp.status, hdr);
      const reader = resp.body.getReader();
      while (true) { const c = await reader.read(); if (c.done) break; res.write(c.value); }
      res.end();
    } catch (err) { console.error('[Cover]', err); res.writeHead(500); res.end(); }
    return;
  }

  // ---------- 音频代理 (支持 Range) ----------
  if (pn === '/api/audio') {
    try {
      const audioUrl = url.searchParams.get('url');
      if (!audioUrl) { res.writeHead(400); res.end('Missing url'); return; }
      const range = req.headers.range || '';
      const hdr = audioProxyHeadersFor(audioUrl, range);
      const up = await fetch(audioUrl, { headers: hdr });
      const out = {
        'Content-Type': audioContentTypeForUrl(audioUrl, up.headers.get('content-type')),
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
      };
      const cl = up.headers.get('content-length'); if (cl) out['Content-Length'] = cl;
      const cr = up.headers.get('content-range');  if (cr) out['Content-Range']  = cr;
      res.writeHead(up.status, out);
      const reader = up.body.getReader();
      while (true) { const c = await reader.read(); if (c.done) break; res.write(c.value); }
      res.end();
    } catch (err) { console.error('[Audio]', err); res.writeHead(500); res.end(); }
    return;
  }

  // ---------- 静态资源 ----------
  if (pn === '/favicon.ico') {
    serveStatic(res, path.join(__dirname, 'build', 'icon.ico'));
    return;
  }

  let filePath = pn === '/' ? '/index.html' : pn;
  filePath = path.join(__dirname, 'public', filePath);
  serveStatic(res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log('======================================================');
  console.log(' 粒子音乐可视化 v2  →  http://localhost:' + PORT);
  console.log(' 登录态: ' + (userCookie ? '已登录(cookie已加载)' : '未登录'));
  console.log('======================================================');
});

module.exports = server;
