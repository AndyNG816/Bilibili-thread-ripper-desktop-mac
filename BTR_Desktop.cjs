"use strict";
// BTR Desktop macOS launcher. The Windows repo ships a native BTR_Desktop.exe that doubles
// as both the maintenance UI and a CLI for the in-client renderer to drive via spawn. On
// macOS we ship a Node CLI script with the same surface; the bash wrapper BTR_Desktop gives
// it a stable, shell-friendly entry point.
const fs = require("node:fs"), path = require("node:path");
const cp = require("./tools/client-package.cjs");

const USAGE = `BTR_Desktop — BTR Desktop macOS launcher

Usage:
  BTR_Desktop status    --client <path> [--noninteractive]
  BTR_Desktop install   --client <path> [--noninteractive]
  BTR_Desktop repair    --client <path> [--noninteractive]
  BTR_Desktop remove    --client <path> [--noninteractive] [--keep-record]
  BTR_Desktop launch    --client <path> [--noninteractive]
  BTR_Desktop forget    --client <path> [--noninteractive]
  BTR_Desktop check-remove --client <path> [--noninteractive]

Options:
  --client <path>     Absolute path to /Applications/哔哩哔哩.app
  --noninteractive    Reserved for parity with the Windows launcher; the Mac version
                      does not show a console UI on its own
  --keep-record       (remove only) Keep the deployment record after restoring
  --version <x.y.z.w-dN>  (repair/update only) Expected payload version
  --sha256 <hex>      (repair/update only) Expected payload sha256

Exit codes:
  0   success
  1   generic failure
  2   client structure not recognised (no modification done)
  3   another maintenance task is already running
  4   requested action would not change anything (already installed / not installed)
`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) { out.flags[key] = true; continue; }
      out.flags[key] = next;
      i += 1;
    } else out._.push(arg);
  }
  return out;
}

function emit(result) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

function fail(message, code = 1) {
  process.stderr.write(message + "\n");
  emit({ state: "error", message });
  process.exit(code);
}

// Ensure ~/Library/Application Support/BTR_Desktop exists. The patcher writes backups there
// when the bundle itself is not writable.
function ensureSupportDirectory() {
  const dir = path.join(require("node:os").homedir(), "Library", "Application Support", "BTR_Desktop");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  const argv = process.argv.slice(2);
  const { _, flags } = parseArgs(argv);
  const action = _[0];
  if (!action || action === "help" || action === "--help" || flags.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (!flags.client || !path.isAbsolute(String(flags.client))) fail("需要 --client 或绝对路径", 1);

  // Best-effort maintenance lock so two concurrent installers (e.g. an in-client update
  // button and the install.sh line) do not race. The lock file lives in the user-writable
  // Application Support folder, not next to the .app bundle.
  ensureSupportDirectory();
  const lockPath = path.join(require("node:os").homedir(), "Library", "Application Support", "BTR_Desktop", "maintenance.lock");
  let lock = null;
  try {
    lock = require("node:fs").openSync(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") fail("另一个 BTR 维护任务正在运行，请稍后重试。", 3);
    throw error;
  }
  process.on("exit", () => { try { require("node:fs").closeSync(lock); require("node:fs").unlinkSync(lockPath); } catch (_) {} });

  try {
    switch (action) {
      case "status": {
        const result = cp.run("status", String(flags.client));
        emit(result);
        process.exit(result.supported ? 0 : 2);
      }
      case "install":
      case "repair": {
        const result = cp.run(action, String(flags.client));
        emit(result);
        if (result.state === "unsupported-client") process.exit(2);
        if (result.state === "installed" || result.state === "current") process.exit(0);
        process.exit(1);
      }
      case "remove": {
        const result = cp.run("remove", String(flags.client));
        emit(result);
        if (result.state === "not-installed") process.exit(4);
        process.exit(result.state === "removed" ? 0 : 1);
      }
      case "check-remove": {
        const result = cp.run("check-remove", String(flags.client));
        emit(result);
        process.exit(0);
      }
      case "launch": {
        // The launcher does not spawn the binary directly; doing so inherits the parent's
        // process group, and an in-client spawn would just keep the client in the dock.
        // Instead, use `open` so the patched bundle is launched by Launch Services.
        const result = cp.run("status", String(flags.client));
        const target = result.target || String(flags.client);
        const { spawnSync } = require("node:child_process");
        const open = spawnSync("open", [target], { stdio: "ignore" });
        if (open.status !== 0) fail("open 命令失败，客户端未启动。", 1);
        emit({ state: "launched", clientVersion: result.clientVersion, installed: !!result.installed });
        process.exit(0);
      }
      case "forget": {
        // Drop the deployment record without touching the .app. The Mac guard exits once its
        // record is gone, mirroring the Windows `forget` action.
        const { run } = cp;
        const status = run("status", String(flags.client));
        if (status.target) {
          const stateFile = (() => {
            const safe = require("node:crypto").createHash("sha256").update(require("node:fs").realpathSync(status.target)).digest("hex").slice(0, 16);
            return path.join(require("node:os").homedir(), "Library", "Application Support", "BTR_Desktop", "backups", `deployment-${safe}.json`);
          })();
          try { fs.unlinkSync(stateFile); } catch (_) {}
        }
        emit({ state: "forgot" });
        process.exit(0);
      }
      default:
        process.stdout.write(USAGE);
        process.exit(1);
    }
  } catch (error) {
    fail(error.message || String(error), 1);
  }
}

main();