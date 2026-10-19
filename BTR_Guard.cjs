"use strict";
// BTR Desktop macOS guard. The Windows guard is a native exe that registers itself with
// Task Scheduler. On macOS the equivalent is a per-user launchd agent that runs the
// BTR_Guard.cjs script at login and whenever the patched asar's recorded sha changes.
//
// The guard does not patch or unpatch anything itself. When it detects that the official
// installer replaced app.asar (the recorded patched sha no longer matches the file on
// disk), it opens Terminal.app running install.sh reconnect, so the user can confirm a
// fresh patch in the same flow as the first install.

const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname);
const SUPPORT_DIR = path.join(os.homedir(), "Library", "Application Support", "BTR_Desktop");
const BACKUP_DIR = path.join(SUPPORT_DIR, "backups");
const DISABLE_FILE = path.join(SUPPORT_DIR, "guard.disabled");
const PLIST_NAME = "com.btr.desktop.guard.plist";
const PLIST_PATH = path.join(os.homedir(), "Library", "LaunchAgents", PLIST_NAME);
const LOG_PATH = path.join(SUPPORT_DIR, "logs", "guard.log");
const LAUNCHD_LABEL = "com.btr.desktop.guard";
const { Asar } = require("./tools/asar.cjs");
const patcher = require("./tools/client-package.cjs");

function sha(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function nowIso() { return new Date().toISOString(); }
function logLine(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `${nowIso()} ${line}\n`);
  } catch (_) {}
}

function launchctl(args) {
  try { return spawnSync("launchctl", args, { stdio: "ignore" }).status; } catch (_) { return 1; }
}

function writePlist() {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${path.join(ROOT, "BTR_Guard")}</string>
    <string>watch</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/><key>Crashed</key><true/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${LOG_PATH}</string>
  <key>StandardErrorPath</key><string>${LOG_PATH}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.writeFileSync(PLIST_PATH, plist);
}

function register() {
  writePlist();
  launchctl(["bootout", `gui/${process.getuid?.() ?? os.userInfo().uid}`, PLIST_PATH]);
  const status = launchctl(["bootstrap", `gui/${process.getuid?.() ?? os.userInfo().uid}`, PLIST_PATH]);
  if (status !== 0) {
    // Some macOS releases reject bootout when nothing is loaded yet; ignore that one.
    launchctl(["enable", `gui/${process.getuid?.() ?? os.userInfo().uid}/${LAUNCHD_LABEL}`]);
  }
  logLine(`guard registered at ${PLIST_PATH}`);
}

function unregister() {
  launchctl(["bootout", `gui/${process.getuid?.() ?? os.userInfo().uid}`, PLIST_PATH]);
  try { fs.unlinkSync(PLIST_PATH); } catch (_) {}
  logLine("guard unregistered");
}

function deploymentRecords() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(name => name.startsWith("deployment-") && name.endsWith(".json"))
    .map(name => { try { return JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, name), "utf8")); } catch (_) { return null; } })
    .filter(Boolean);
}

function locateAsar(clientPath) {
  // Reuse the patcher's path detection so the guard sees the same .asar the patcher
  // touched. Returns the .app bundle root (one level up from Contents/) plus the target.
  const located = patcher.locateAsar(clientPath);
  const appRoot = located.client.endsWith(".app") ? located.client : located.client.split(".app/")[0] + ".app";
  return { client: appRoot, target: located.target };
}

function findClientPathFor(deployment) {
  // The deployment does not store the client path on Mac because the backup lives outside
  // the .app. Walk through the standard install locations, ask the patcher for the asar
  // target, and confirm it reports the same client version we patched.
  const version = deployment.clientVersion;
  if (!version) return null;
  const candidates = ["/Applications/哔哩哔哩.app", "/Applications/bilibili.app"];
  for (const candidate of candidates) {
    try {
      const { target } = patcher.locateAsar(candidate);
      const bytes = fs.readFileSync(target);
      const info = patcher.inspect(new Asar(bytes));
      if (info.clientVersion === version) return candidate;
    } catch (_) { /* missing or unparsable; try the next one. */ }
  }
  return null;
}

function currentAsarSha(target) {
  try { return sha(fs.readFileSync(target)); } catch (_) { return null; }
}

function openReconnectTerminal(clientPath) {
  // Open Terminal.app running the install.sh reconnect flow so the user sees the same
  // progress UI as a fresh install. Terminal will outlive the guard process.
  const script = path.join(ROOT, "install.sh");
  if (!fs.existsSync(script)) return false;
  const cmd = `clear; echo "BTR 检测到哔哩哔哩客户端被重新安装，是否重新接入 BTR？"; /bin/bash ${JSON.stringify(script)} --reconnect --client ${JSON.stringify(clientPath)} --noninteractive || { echo; echo "重新接入失败，按任意键关闭窗口。"; read -n 1; }`;
  const apple = `tell application "Terminal" to do script ${JSON.stringify(cmd)}`;
  const result = spawnSync("osascript", ["-e", apple], { stdio: "ignore" });
  return result.status === 0;
}

function watch() {
  if (fs.existsSync(DISABLE_FILE)) {
    logLine("guard disabled by user; exiting");
    process.exit(0);
  }
  const seen = new Map();
  for (const deployment of deploymentRecords()) {
    const clientPath = findClientPathFor(deployment);
    if (!clientPath) continue;
    const target = path.join(clientPath, "Contents", "Resources", "app.asar");
    seen.set(target, deployment);
  }
  if (!seen.size) {
    logLine("no deployment records; guard will not start watching");
    process.exit(0);
  }
  logLine(`guard watching ${seen.size} deployment${seen.size === 1 ? "" : "s"}`);
  const interval = setInterval(() => {
    if (fs.existsSync(DISABLE_FILE)) { clearInterval(interval); process.exit(0); }
    for (const [target, deployment] of seen) {
      const actual = currentAsarSha(target);
      if (!actual) continue;
      if (actual === deployment.patchedSha256 || actual === deployment.originalSha256) continue;
      // The user (or the official updater) replaced app.asar. Offer to re-patch.
      const clientPath = path.join(target.split("/Contents/")[0]);
      logLine(`asar mismatch at ${target} (${actual.slice(0, 12)}); prompting reconnect`);
      openReconnectTerminal(clientPath);
      // Drop the deployment so we don't keep prompting every 30 s until the user finishes.
      try { fs.unlinkSync(path.join(BACKUP_DIR, `deployment-${require("node:crypto").createHash("sha256").update(require("node:fs").realpathSync(target)).digest("hex").slice(0, 16)}.json`)); } catch (_) {}
      clearInterval(interval);
      process.exit(0);
    }
  }, 30 * 1000);
  process.on("SIGTERM", () => { clearInterval(interval); process.exit(0); });
  process.on("SIGHUP", () => { clearInterval(interval); process.exit(0); });
}

function disable() {
  try { fs.writeFileSync(DISABLE_FILE, ""); logLine("guard disabled"); } catch (_) {}
}

function enable() {
  try { fs.unlinkSync(DISABLE_FILE); logLine("guard enabled"); } catch (_) {}
}

const action = process.argv[2];
if (action === "guard" && process.argv[3] === "--register") register();
else if (action === "guard" && process.argv[3] === "--unregister") unregister();
else if (action === "watch") watch();
else if (action === "disable") disable();
else if (action === "enable") enable();
else { logLine(`unknown action ${action}`); process.exit(1); }