# 桌面壁纸模式 — 重新设计（方案 A：浮于图标上方 + 动态点击穿透）

> 本文档取代同目录 `2026-07-11-wallpaper-final-design.md`（旧 WorkerW 挂载方案已废弃）。

## 目标

将 Mineradio 主窗口变换为桌面悬浮播放器：

- 全屏透明，看不出软件边框
- 所有按钮、3D 歌单架、粒子视觉、播放功能正常
- 桌面图标透过透明区域可见；无 UI 的空白区域可点击图标
- Ctrl+D / Win+D 不隐藏窗口
- 整体像悬浮在桌面上的播放器

## 为什么不用旧的 WorkerW 方案

旧方案把窗口 `SetParent` 到 WorkerW（桌面图标背后）。Windows 的桌面图标层 `SHELLDLL_DefView` 拦截所有鼠标事件，挂到 WorkerW 上的窗口收不到点击 → 所有按钮失效。Wallpaper Engine 靠底层输入钩子绕过这个限制，Electron 无法直接复制。

## 架构 — 单窗口变换（不创建新窗口）

```
主窗口（已存在, transparent:true, frame:false）
  │
  ├─ 正常模式: CSS 不透明深色背景, 正常窗口行为
  │
  └─ 桌面壁纸模式 (toggle):
       ├─ 全屏（primary display bounds）
       ├─ skipTaskbar: true（不出现在任务栏）
       ├─ setIgnoreMouseEvents(true, {forward:true}) 默认点击穿透
       ├─ Z-order: SetWindowPos(HWND_BOTTOM) 钉在普通窗口最底
       │   （仍在桌面图标之上，但在其他应用窗口之下）
       ├─ Win+D 抵抗: minimize 事件 → 立即 restore + 重新钉底
       ├─ CSS body.desktop-wallpaper-mode: 透明背景 + 玻璃面板
       └─ 渲染层 mousemove: 动态切换点击穿透/捕获
```

**关键：直接变换主窗口，不创建新窗口。** 主窗口已经是 `transparent: true`，无需改创建参数。所有播放状态、3D 场景、粒子预设保持运行，零中断、零状态同步。

## Z-Order 策略

桌面 Z-order 从上到下：

```
其他应用窗口（焦点窗口在上）
┬── 我们的窗口（HWND_BOTTOM = 普通窗口最底）  ← 壁纸模式位置
┴── Progman（桌面壁纸 + 图标）               ← 始终在最底
```

`HWND_BOTTOM` 让窗口停在所有普通窗口的最底，但仍高于 Progman（桌面图标层）。效果：

- 桌面图标在窗口背后 → 透过透明区域可见
- 其他应用打开时自然浮在我们上方
- 我们不会遮挡其他应用

实现：进入壁纸模式后，用 PowerShell `SetWindowPos(hwnd, HWND_BOTTOM, SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE)` 钉底，并在 `focus` 事件和 2 秒定时器上重新钉底（防止点击按钮后窗口浮到顶层）。

## 动态点击穿透

默认 `setIgnoreMouseEvents(true, {forward:true})`：整个窗口点击穿透，鼠标移动事件仍转发给渲染层。

渲染层 `mousemove` 监听器：

```js
document.addEventListener('mousemove', (e) => {
  if (!document.body.classList.contains('desktop-wallpaper-mode')) return;
  const interactive = e.target.closest(
    'button, a, input, textarea, select, canvas, [role="button"], ' +
    '#bottom-bar, #search-area, #playlist-panel, #fx-panel, ' +
    '.home-card, .home-tile, .home-rail, .home-hero, [data-interactive]'
  );
  const shouldCapture = !!interactive;
  if (shouldCapture !== currentCapture) {
    currentCapture = shouldCapture;
    api.setDesktopWallpaperCapture(shouldCapture); // IPC → setIgnoreMouseEvents(!shouldCapture)
  }
});
```

- 鼠标在按钮/面板/3D canvas 上 → 捕获，点击生效
- 鼠标在空白透明区 → 穿透，点击到达桌面图标
- `forward:true` 保证 mousemove 始终转发，能检测当前元素
- 仅在状态变化时发 IPC，避免每帧刷

**3D canvas 处理：** canvas 作为交互元素，鼠标在其上时捕获点击，3D 拖拽/滚轮/卡片点击全部保留。canvas 覆盖区域内的桌面图标不可点击（这是必要折中，保证 3D 全交互）。

## Win+D / Ctrl+D 抵抗

Windows "显示桌面"（Win+D / Win+M / 任务栏 Show Desktop 按钮）会最小化所有普通窗口。抵抗策略：

1. `skipTaskbar: true` — 窗口不在任务栏，减少被 shell 批量最小化的概率
2. `mainWindow.on('minimize', ...)` — 进入壁纸模式时监听 minimize 事件，立即 `restore()` + `show()` + 重新 `SetWindowPos(HWND_BOTTOM)`
3. 恢复在微秒级完成，视觉上窗口"不消失"

如果实测闪烁明显，后续可加全局键盘钩子（PowerShell `SetWindowsHookEx`）拦截 Win+D，但 v1 先用最小化恢复方案。

## 视觉 / CSS

`body.desktop-wallpaper-mode` 激活时：

```css
.desktop-wallpaper-mode html,
.desktop-wallpaper-mode body { background: transparent !important; }
.desktop-wallpaper-mode #desktop-window-shell {
  top: 0 !important; left: 0 !important;
  width: 100vw !important; height: 100vh !important;
  border-radius: 0 !important; border: none !important;
  background: transparent !important;
}
.desktop-wallpaper-mode #desktop-titlebar { display: none !important; }
.desktop-wallpaper-mode .desktop-window-controls { display: none !important; }
.desktop-wallpaper-mode #bottom-bar {
  background: rgba(8,8,14,.5) !important;
  backdrop-filter: blur(28px) saturate(1.3) !important;
  border: 1px solid rgba(255,255,255,.06) !important;
}
.desktop-wallpaper-mode .home-card,
.desktop-wallpaper-mode .home-tile,
.desktop-wallpaper-mode .home-rail,
.desktop-wallpaper-mode #search-area,
.desktop-wallpaper-mode #playlist-panel,
.desktop-wallpaper-mode #fx-panel {
  background: rgba(12,12,20,.45) !important;
  backdrop-filter: blur(24px) saturate(1.3) !important;
  border: 1px solid rgba(255,255,255,.06) !important;
}
.desktop-wallpaper-mode .icon-btn {
  background: rgba(12,12,20,.4) !important;
  backdrop-filter: blur(16px) !important;
}
```

**边界（来自 PROJECT_MEMORY，必须遵守）：**

- 不动 `#mineradio-control-glass-filter` 黄金 SVG 玻璃质感
- 不动 `--saved-panel-glass-*` / `--saved-button-glass-*` 变量
- 玻璃只覆盖容器背景，不改播放器控制台质感核心

## 修改文件

| 文件 | 改动 |
|------|------|
| `desktop/main.js` | 新增 `enterDesktopWallpaperMode()` / `exitDesktopWallpaperMode()` / `restoreMainWindowState()` / `pinWindowToBottom()` / `desktopWallpaperClickThrough` IPC。不创建新窗口，变换主窗口。复用现有 `MineradioNativeWin` PowerShell 类。 |
| `desktop/preload.js` | 新增 `toggleDesktopWallpaperMode()` / `setDesktopWallpaperCapture(capture)` API |
| `public/index.html` | 新增壁纸按钮 + `toggleDesktopWallpaper()` / `desktop-wallpaper-mode` CSS / mousemove 动态穿透监听 |

## 进入 / 退出流程

```
enterDesktopWallpaperMode():
  1. 保存 mainWindow 状态 (bounds, isMaximized, isFullScreen)
  2. mainWindow.setSkipTaskbar(true)
  3. unmaximize → setBounds(primaryDisplay.bounds)
  4. setIgnoreMouseEvents(true, {forward:true})
  5. pinWindowToBottom()  (SetWindowPos HWND_BOTTOM)
  6. IPC → renderer: 激活 desktop-wallpaper-mode CSS + mousemove 监听
  7. 启动 pinToBottom 定时器 (2s)
  8. 监听 minimize → restore + pinToBottom

exitDesktopWallpaperMode():
  1. 停止 pinToBottom 定时器
  2. setIgnoreMouseEvents(false)
  3. mainWindow.setSkipTaskbar(false)
  4. 恢复 bounds / maximized
  5. IPC → renderer: 移除 desktop-wallpaper-mode CSS + mousemove 监听
```

## 已知限制（v1）

- 单显示器：仅覆盖主显示器
- 3D canvas 覆盖区域的桌面图标不可点击（保证 3D 全交互）
- Win+D 恢复可能有极短闪烁（可后续加全局钩子优化）

## 切换按钮位置

在标题栏 `#desktop-titlebar` 区域新增一个壁纸模式切换按钮（图标按钮，与最小化/关闭等窗口控件并列），点击调用 `toggleDesktopWallpaper()`。
