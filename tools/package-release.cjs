"use strict";
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
const { sha } = require("./asar.cjs");
const { RAW, VERSION } = require("./update-provider.cjs");
const root = path.resolve(__dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(root, "desktop.json")));
if (!VERSION.test(config.version)) throw Error("Invalid desktop version");

const files = [
  "BTR_Desktop", "BTR_Desktop.cjs",
  "BTR_Guard", "BTR_Guard.cjs",
  "desktop.json", "install.sh", "force-update.sh",
  "README.md", "LICENSE",
  "launchd/com.btr.desktop.guard.plist",
  "dist/desktop.js", "dist/payload.json",
  "src/bootstrap.cjs", "src/update-main.cjs",
  "tools/asar.cjs", "tools/client-package.cjs",
  "tools/update-provider.cjs", "tools/https-json.cjs"
];

const staging = fs.mkdtempSync(path.join(root, "release-stage-"));
const directory = path.join(staging, "BTR_Desktop");
try {
  for (const file of files) {
    const dest = path.join(directory, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, file), dest);
  }
  // ditto -k creates a zip that preserves macOS metadata better than /usr/bin/zip. The
  // compression level keeps the archive small without slowing the build noticeably.
  const temporary = path.join(staging, "package.zip");
  const result = spawnSync("ditto", ["-c", "--sequesterRsrc", "--keepParent", "--zlibCompressionLevel", "9", "-V", "BTR_Desktop", temporary], { cwd: staging, encoding: "utf8" });
  if (result.status !== 0) throw Error((result.stderr || result.stdout || "ditto unavailable").trim());
  const bytes = fs.readFileSync(temporary);
  const packages = path.join(root, "packages");
  fs.mkdirSync(packages, { recursive: true });
  const name = `BTR_Desktop-${config.version}-mac.zip`;
  const archivePath = path.join(packages, name);
  fs.writeFileSync(archivePath, bytes);
  // The URL stays under the BTR Desktop raw path. The Mac install script's manifest
  // validator pins downloadUrl to this exact prefix so a swapped URL can't slip through.
  const manifest = {
    schema: 1,
    version: config.version,
    downloadUrl: RAW + "packages/" + name,
    sha256: sha(bytes),
    supportedClientVersions: config.legacyClientVersions,
    platform: "mac"
  };
  fs.writeFileSync(path.join(root, "latest.mac.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ archive: archivePath, files: files.length, ...manifest }, null, 2));
} finally { fs.rmSync(staging, { recursive: true, force: true }); }