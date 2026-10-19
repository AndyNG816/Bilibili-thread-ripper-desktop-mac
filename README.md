# BTR Desktop macOS

**Bilibili 线程撕裂者的 macOS 桌面版，适用于官方哔哩哔哩 Mac 客户端**

把线程撕裂者带到官方 Mac 客户端里，原来的播放器、字幕、弹幕和快捷键都保留。

当前版本 **2026.10.19.1-d1** · 已在官方客户端 **1.17.5** 实测

[安装](#-安装) · [强制更新](#-强制更新) · [设置](#-设置) · [还原](#-还原) · [和网页版的区别](https://github.com/MrTangLuyao/Bilibili-thread-ripper-desktop/blob/main/difference.md) · [网页版](https://github.com/MrTangLuyao/Bilibili-thread-ripper)

> 这是上游 [BTR Desktop for Windows](https://github.com/MrTangLuyao/Bilibili-thread-ripper-desktop) 的 macOS 移植版。注入到 `app.asar` 里的代码、共享浏览器核心、设置面板、播放器 UI 和下载内核全部沿用上游版本。

## 它能做什么

- 原生客户端不变：播放器、字幕、弹幕和快捷键都保留，BTR 只接管视频下载
- 一行命令安装：在 Terminal 里运行一行命令，自动找到客户端
- 客户端里自动更新：发现新版本会提示，确认后安装并重新打开客户端
- 不怕官方覆盖安装：官方安装包覆盖了 BTR 时，后台 launchd 代理会问你要不要重新接入
- 出问题自动退回：坏节点自动停用；加速连续失败就交回客户端自己下载，不会卡住视频
- 随时一键还原：设置里点卸载就能恢复官方客户端，不动账号和数据

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper-desktop/main/install-mac.sh | bash
```

哔哩哔哩没装在默认位置（`/Applications/哔哩哔哩.app`）也没关系：脚本找不到时会让你输入 .app 的路径。

> Tip
> 你也可以克隆本仓库后运行 `./install.sh --progress` 来使用本地副本。

### 它做了什么

1. 把 `app.asar` 里的 `index.js` 前面加上一行 `require()` 调用，加载 `btr-desktop/bootstrap.cjs`
2. 把 BTR 的代码、配置和下载内核写入 `app.asar` 的 `btr-desktop/` 子目录
3. 把客户端 .app 的原始 `app.asar` 备份到 `~/Library/Application Support/BTR_Desktop/backups/`
4. 用 `codesign --force --deep --sign -` 重新签名 .app（脱机签名），让 macOS 接受这个修改过的 app
5. 注册 launchd 代理 `~/Library/LaunchAgents/com.btr.desktop.guard.plist`，登录后自动启动 BTR_Guard 守护程序

> Note
> 重新签名后，哔哩哔哩原本的 Developer ID 签名会丢失，直到 B 站发版重新签名。app 仍可正常启动并使用全部原有功能，但失去了 Hardened Runtime 保护。

## 强制更新

```bash
curl -fsSL https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper-desktop/main/force-update-mac.sh | bash
```

部分旧版本会遇到更新问题，请务必使用这个脚本来强制更新。

## 设置

入口和 Windows 版完全一致：

| 入口 | 可以调整 |
| --- | --- |
| 系统设置 → 第一项"线程撕裂者" | CDN、线程数、错误提示和 Debug |
| 播放器 ⚙ → 更多播放设置 | CDN 和线程数 |

详细字段说明请参考上游 README。

## 还原

```bash
cd "$(curl -fsSL https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper-desktop/main/latest.mac.json | node -e 'process.stdout.write(JSON.parse(require(\"fs\").readFileSync(0)).version)')-mac-installer"
./install.sh --uninstall --progress
```

或者在哔哩哔哩客户端的"设置 → 线程撕裂者 → 卸载 BTR"里点。

> 进不了设置时，先完全退出客户端，再在 Terminal 里运行 `BTR_Desktop remove --client /Applications/哔哩哔哩.app`。安装位置记录在 `~/Library/Application Support/BTR_Desktop/`，还原后这条记录和 launchd 启动项会一起清掉。

## 开发与发版

下载内核和网页版共用，改进下载内核的代码请提到 [网页版仓库](https://github.com/MrTangLuyao/Bilibili-thread-ripper)，macOS 桌面版会原样同步过来。

### 构建

```
npm install   # 不需要 npm 依赖；这里是文档约定
npm run build
```

把 `desktop.json` 和 `package.json` 的版本信息改好，再运行：

```
npm run release
```

它会把源代码、`dist/`、`packages/` 和 `latest.mac.json` 准备好，commit + push 后 `install.sh` 就会拉取到新版本。

### 烟雾测试

在已安装官方哔哩哔哩的机器上：

```
npm run smoke
```

会读取 `/Applications/哔哩哔哩.app` 的 `app.asar` 并打印 BTR 是否能识别它的入口结构。

## 已知限制

- 只支持 macOS 13 及以上版本（需要 launchd KeepAlive 字典和 codesign 命令）
- 重新签名后失去原 Developer ID；用户可以接受这个折衷，因为这是 BTR 能运行的唯一办法
- 不支持 Apple Silicon 上的 hardened runtime
- 安装需要 macOS 自带的 `node` 命令；如果系统没有（很老的版本），需要先 `brew install node`

## 参与贡献

欢迎提 issue 和 PR。注入代码和共享核心来自上游，本仓库主要维护 macOS 适配层。

## 许可

[MIT](LICENSE)