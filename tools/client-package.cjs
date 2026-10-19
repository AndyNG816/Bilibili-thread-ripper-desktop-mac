"use strict";
let fs;
try { fs = require("original-fs"); } catch (_) { fs = require("node:fs"); }
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { Asar, sha } = require("./asar.cjs");
const project = path.resolve(__dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(project, "desktop.json")));
const BUNDLE_FILE = "btr-desktop/desktop.js", BOOTSTRAP_FILE = "btr-desktop/bootstrap.cjs";

// Mac-specific layout: /Applications/哔哩哔哩.app/Contents/Resources/app.asar
// Windows layout:     C:\Program Files\bilibili\resources\app.asar
function locateAsar(clientPath) {
  const client = fs.realpathSync(clientPath);
  const stat = fs.statSync(client);
  const isDir = stat.isDirectory();
  if (!isDir) {
    if (path.extname(client) !== ".asar") throw Error("目标必须是客户端 ASAR 资源");
    return { client, target: client, kind: "asar" };
  }
  const macCandidate = path.join(client, "Contents", "Resources", "app.asar");
  const winCandidate = path.join(client, "resources", "app.asar");
  const target = fs.existsSync(macCandidate) ? macCandidate : fs.existsSync(winCandidate) ? winCandidate : null;
  if (!target) throw Error("找不到客户端 ASAR 资源（已尝试 Contents/Resources/app.asar 和 resources/app.asar）");
  return { client, target, kind: target.endsWith("Contents/Resources/app.asar") ? "mac-bundle" : "windows-folder" };
}

function bundleSupportDirectory() {
  // On Mac the .app is read-only by default and lives under /Applications; we cannot safely
  // store a backup beside it. Use the user-writable Application Support folder instead.
  return path.join(os.homedir(), "Library", "Application Support", "BTR_Desktop", "backups");
}

function stateFileFor(target) {
  const safe = sha(fs.realpathSync(target)).slice(0, 16);
  return path.join(bundleSupportDirectory(), `deployment-${safe}.json`);
}

function backupPathFor(hash) {
  return path.join(bundleSupportDirectory(), `${hash}.asar`);
}

function pruneSupportDirectory() {
  const dir = bundleSupportDirectory();
  const removed = [];
  if (!fs.existsSync(dir)) return removed;
  const kept = new Set();
  try {
    for (const name of fs.readdirSync(dir)) if (name.startsWith("deployment-") && name.endsWith(".json")) {
      try { kept.add(JSON.parse(fs.readFileSync(path.join(dir, name))).originalSha256); } catch (_) {}
    }
    for (const name of fs.readdirSync(dir)) {
      const match = /^([a-f0-9]{64})\.asar$/.exec(name);
      if (match && !kept.has(match[1])) { fs.unlinkSync(path.join(dir, name)); removed.push(name); }
    }
  } catch (_) { /* Already succeeded; leftover backups are harmless. */ }
  return removed;
}

// Re-sign the patched .app bundle so macOS will launch it. Ad-hoc is sufficient for local
// use; the original Developer ID signature is lost until B站 ships an update.
function resignBundle(client) {
  if (process.platform !== "darwin") return { skipped: true };
  if (!client.endsWith(".app") && !client.includes(".app/")) return { skipped: true };
  const appRoot = client.endsWith(".app") ? client : client.split(".app/")[0] + ".app";
  const result = spawnSync("codesign", ["--force", "--deep", "--sign", "-", appRoot], { encoding: "utf8" });
  if (result.status !== 0) {
    throw Error(`重新签名失败：${(result.stderr || result.stdout || "").trim() || "未知错误"}`);
  }
  return { resigned: appRoot };
}

// BTR must never stop the official client from starting, whatever its version.
function bootstrapPrefix(entry) {
  const relative = path.posix.relative(path.posix.dirname(entry), BOOTSTRAP_FILE);
  return `try{require(${JSON.stringify(relative.startsWith(".") ? relative : "./" + relative)})}catch(error){console.error("BTR bootstrap:",error&&error.message)}\n`;
}
// A BOM and a leading "use strict" directive must stay first, or the official file changes meaning.
function splitHead(text) {
  const head = /^﻿?(?:\s*(["'])use strict\1[ \t]*;?[ \t]*(?:\r?\n)?)?/.exec(text)[0];
  return [head, text.slice(head.length)];
}
function withBootstrap(entry, text) { const [head, body] = splitHead(text); return head + bootstrapPrefix(entry) + body; }
function hasBootstrap(entry, text) { return splitHead(text)[1].startsWith(bootstrapPrefix(entry)); }
function hooks(bundle) {
  const bootstrap = fs.readFileSync(path.join(project, "src", "bootstrap.cjs"));
  const preload = Buffer.from(`"use strict";\n(() => {\n` +
    `if (!process.isMainFrame || location.origin !== "https://bilipc.bilibili.com" || !/^\\/(index|player)\\.html$/.test(location.pathname)) return;\n` +
    `const {ipcRenderer}=require("electron"),channel="__BTR_DESKTOP_UPDATE__";\n` +
    `let checking=false,acting=false,epoch=0,configEpoch=0; const send=result=>window.postMessage({channel,type:"result",result},location.origin);\n` +
    `ipcRenderer.on("btr-desktop:maintenance-result",(_event,result)=>send(result));\n` +
    `window.addEventListener("message",async event=>{if(event.source!==window||event.data?.channel!==channel||event.data.type!=="configure-auto"||typeof event.data.enabled!=="boolean")return;const ticket=++configEpoch;try{const result=await ipcRenderer.invoke("btr-desktop:auto-config",{enabled:event.data.enabled,changed:event.data.changed===true});if(ticket===configEpoch)window.postMessage({channel,type:"auto-config",enabled:result.enabled},location.origin);}catch(_){}});\n` +
    `window.addEventListener("message",async event=>{if(event.source!==window||event.data?.channel!==channel||event.data.type!=="check"||checking||acting)return;checking=true;const ticket=epoch;try{const result=await ipcRenderer.invoke("btr-desktop:update-check");if(ticket===epoch)send(result);}catch(_){if(ticket===epoch)send({state:"error",message:"更新检查失败，请稍后重试"});}finally{checking=false;}});\n` +
    `document.addEventListener("click",async event=>{if(!event.isTrusted||acting||!event.target.closest?.("#btr-desktop-settings"))return;const button=event.target.closest?.("#btr-desktop-install-update,#btr-desktop-uninstall");if(!button||button.disabled)return;const remove=button.id==="btr-desktop-uninstall";acting=true;epoch++;send({state:"confirming",message:remove?"请确认是否卸载 BTR":"请确认是否安装更新"});try{send(await ipcRenderer.invoke(remove?"btr-desktop:uninstall":"btr-desktop:update-install"));}catch(_){send({state:"error",message:remove?"无法启动卸载，请稍后重试":"无法启动更新，请重新运行安装命令"});}finally{acting=false;}},true);\n` +
    `const code = ${JSON.stringify(bundle.toString("utf8"))};\n` +
    `let injected = false;\nfunction inject() { if (injected || !document.documentElement) return; injected = true; observer.disconnect(); const script = document.createElement("script"); script.textContent = code; (document.head || document.documentElement).appendChild(script); script.remove(); }\n` +
    `const observer = new MutationObserver(inject); observer.observe(document, {childList:true,subtree:true}); inject();\n})();\n`);
  return { bootstrap, preload,
    "update-main":fs.readFileSync(path.join(project,"src","update-main.cjs")),
    "update-provider":fs.readFileSync(path.join(project,"tools","update-provider.cjs")),
    "https-json":fs.readFileSync(path.join(project,"tools","https-json.cjs")),
    "update-config":Buffer.from(JSON.stringify({...config,installerSha256:sha(fs.readFileSync(path.join(project,"install.sh"))),launcherSha256:sha(fs.readFileSync(path.join(project,"BTR_Desktop"))),guardSha256:sha(fs.readFileSync(path.join(project,"BTR_Guard")))}))
  };
}
const hookFile = key => `btr-desktop/${key}.${key === "update-config" ? "json" : "cjs"}`;
function sameHooks(archive, expected) {return Object.entries(expected).every(([key,value]) => archive.entry(hookFile(key)) && sha(archive.read(hookFile(key))) === sha(value));}
// Electron starts package.json "main" (index.js by default). Only a plain JavaScript entry
// stored inside the archive can take the BTR prefix; anything else is left untouched.
function mainEntry(archive, app) {
  const main = typeof app.main === "string" && app.main.trim() ? app.main.trim().replace(/^\.\//, "") : "index.js";
  for (const name of [main, `${main}.js`, `${main}/index.js`]) {
    try {
      const entry = archive.entry(name);
      if (/\.c?js$/.test(name) && entry && !entry.files && !entry.unpacked && !entry.link) return name;
    } catch (_) { return null; }
  }
  return null;
}
function inspect(archive) {
  let app;
  try { app = JSON.parse(archive.text("package.json")); } catch (_) { app = null; }
  if (app?.name !== "bilibili") throw Error("目标不是官方 Bilibili 客户端");
  let installed = null;
  if (archive.entry("btr-desktop/installed.json")) installed = JSON.parse(archive.text("btr-desktop/installed.json"));
  return { clientVersion: String(app.version || "unknown"), installed, entry: mainEntry(archive, app) };
}
function patch(original, bundle, metadata) {
  const info = inspect(original);
  if (info.installed) throw Error("只能在已验证的原始备份上制作补丁");
  if (!info.entry) throw Error(`无法识别客户端 ${info.clientVersion} 的入口结构，没有修改官方文件`);
  const entry = original.text(info.entry);
  if (entry.includes(BOOTSTRAP_FILE)) throw Error("客户端已经包含 BTR 入口");
  original.set(info.entry, withBootstrap(info.entry, entry));
  for (const [key,value] of Object.entries(hooks(bundle))) original.set(hookFile(key),value);
  original.set(BUNDLE_FILE, bundle);
  original.set("btr-desktop/installed.json", JSON.stringify(metadata));
  return original.pack();
}
function run(action, clientPath) {
  if (!clientPath || !path.isAbsolute(clientPath)) throw Error("需要客户端绝对路径");
  const { client, target, kind } = locateAsar(clientPath);
  if (fs.lstatSync(target).isSymbolicLink()) throw Error("不处理链接形式的客户端资源");
  const bytes = fs.readFileSync(target), hash = sha(bytes), archive = new Asar(bytes), info = inspect(archive);
  if (action === "status") {
    const bundle = fs.readFileSync(path.join(project, "dist", "desktop.js")), expected = hooks(bundle);
    return { ...info, kind, path: client, target, sha256: hash, current: isCurrent(archive, info, sha(bundle), expected), supported: !!info.entry };
  }
  const stateFile = stateFileFor(target);
  const deployment = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : null;
  if (action === "remove" || action === "check-remove") {
    if (!info.installed) return { state: "not-installed" };
    if (!deployment || deployment.patchedSha256 !== hash || deployment.clientVersion !== info.clientVersion) throw Error("当前客户端与安装记录不匹配，拒绝覆盖。请重新安装官方客户端。");
    if (!/^[a-f0-9]{64}$/.test(deployment.originalSha256) || deployment.originalSha256 !== info.installed.originalSha256) throw Error("原始备份记录不匹配");
    const backup = backupPathFor(deployment.originalSha256);
    const original = fs.readFileSync(backup);
    const originalInfo = inspect(new Asar(original));
    if (sha(original) !== deployment.originalSha256 || originalInfo.installed || originalInfo.clientVersion !== info.clientVersion) throw Error("备份校验失败");
    if (action === "check-remove") return { state:"ready-to-remove", originalSha256:deployment.originalSha256 };
    replace(target, original);
    const resign = resignBundle(client);
    try { fs.unlinkSync(stateFile); } catch (_) {}
    return { state: "removed", clientVersion: info.clientVersion, resign, message: "已恢复官方资源，备份和用户设置保留" };
  }
  if (!["install", "repair"].includes(action)) throw Error("未知操作");
  if (!info.entry) return { state: "unsupported-client", clientVersion: info.clientVersion, message: "无法识别客户端入口结构，保持官方程序不变" };
  const bundle = fs.readFileSync(path.join(project, "dist", "desktop.js"));
  const payload = JSON.parse(fs.readFileSync(path.join(project, "dist", "payload.json")));
  if (sha(bundle) !== payload.sha256) throw Error("BTR 文件校验失败");
  const expected = hooks(bundle);
  if (isCurrent(archive, info, payload.sha256, expected)) return { state: "current", clientVersion: info.clientVersion };
  let originalBytes = bytes;
  if (info.installed) {
    const backupHash = info.installed.originalSha256;
    if (!/^[a-f0-9]{64}$/.test(backupHash)) throw Error("Invalid original backup hash");
    originalBytes = fs.readFileSync(backupPathFor(backupHash));
    if (sha(originalBytes) !== backupHash || inspect(new Asar(originalBytes)).clientVersion !== info.clientVersion) throw Error("原始备份不匹配");
  }
  const originalHash = sha(originalBytes);
  const metadata = { schema: 1, version: config.version, adapterRevision: config.adapterRevision, clientVersion: info.clientVersion, originalSha256: originalHash, payloadSha256: payload.sha256, installRoot:project };
  const patched = patch(new Asar(originalBytes), bundle, metadata);
  const verify = new Asar(patched);
  if (sha(verify.read(BUNDLE_FILE)) !== payload.sha256) throw Error("补丁自检失败");
  const supportDir = bundleSupportDirectory();
  fs.mkdirSync(supportDir, { recursive: true });
  const backup = backupPathFor(originalHash);
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, originalBytes, { flag: "wx" });
  if (sha(fs.readFileSync(backup)) !== originalHash) throw Error("备份内容校验失败");
  replace(target, patched);
  const resign = resignBundle(client);
  fs.writeFileSync(stateFile, JSON.stringify({ ...metadata, patchedSha256: sha(patched) }, null, 2));
  return { state: "installed", clientVersion: info.clientVersion, version: config.version, backupPath: backup, resign, removedBackups: pruneSupportDirectory() };
}
function isCurrent(archive, info, bundleHash, expected) {
  return !!(info.installed && info.entry && info.installed.payloadSha256 === bundleHash && archive.entry(BUNDLE_FILE) && sha(archive.read(BUNDLE_FILE)) === bundleHash
    && hasBootstrap(info.entry, archive.text(info.entry)) && sameHooks(archive, expected) && info.installed.installRoot === project);
}
function replace(target, bytes) {
  const temporary = `${target}.btr-${process.pid}.tmp`;
  fs.writeFileSync(temporary, bytes, { flag: "wx" });
  try {
    if (sha(fs.readFileSync(temporary)) !== sha(bytes)) throw Error("写入校验失败");
    fs.renameSync(temporary, target);
  } catch (error) { try { fs.unlinkSync(temporary); } catch (_) {} throw error; }
}
if (require.main === module) {
  const report = value => { if (process.argv[4]) fs.writeFileSync(process.argv[4], JSON.stringify(value, null, 2)); };
  Promise.resolve().then(() => process.argv[2] === "check-update" ? require("./update-provider.cjs").check(config.update, config) : run(process.argv[2] || "status", process.argv[3]))
    .then(result => { report(result); console.log(JSON.stringify(result, null, 2)); })
    .catch(error => { report({ state: "error", message: error.message }); console.error(error.message); process.exitCode = 1; });
}
module.exports = { inspect, patch, run, locateAsar, resignBundle };