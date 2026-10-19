#!/usr/bin/env bash
# BTR Desktop macOS force-update. Mirrors the Windows force-update.ps1.
# Downloads latest.mac.json, verifies the package URL, then runs install.sh --update.
set -euo pipefail

MANIFEST_URL="https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper-desktop/main/latest.mac.json"
RAW_BASE="https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper-desktop/main"

fail() { echo "$1" >&2; exit 1; }

# Download to a temporary file, verify URL prefix, parse JSON fields with node (already
# required by BTR), and reject any URL not pointing at this repository's raw path.
TMP_JSON="$(mktemp -t btr-manifest)"
trap 'rm -f "$TMP_JSON" "$TMP_JSON.tmp"' EXIT
curl --fail --silent --show-error --location --max-time 30 "$MANIFEST_URL?t=$(date +%s)" -o "$TMP_JSON" || fail "无法下载更新清单"

# Validate that the manifest belongs to this repository and is well-formed.
node -e '
  const fs = require("fs");
  const text = fs.readFileSync(process.argv[1], "utf8");
  let value; try { value = JSON.parse(text); } catch (_) { console.error("清单不是合法 JSON"); process.exit(2); }
  if (value.schema !== 1) { console.error("清单格式不被支持"); process.exit(2); }
  if (!/^\d+\.\d+\.\d+\.\d+-d[1-9]\d*$/.test(value.version)) { console.error("清单版本号格式错误"); process.exit(2); }
  if (!/^[a-fA-F0-9]{64}$/.test(value.sha256)) { console.error("清单校验值格式错误"); process.exit(2); }
  const expected = "'"$RAW_BASE"'/packages/BTR_Desktop-" + value.version + "-mac.zip";
  if (value.downloadUrl !== expected) { console.error("下载链接不属于此仓库"); process.exit(2); }
  process.stdout.write(value.version + "\n" + value.sha256 + "\n");
' "$TMP_JSON" > "$TMP_JSON.fields" || fail "manifest"
VERSION="$(sed -n '1p' "$TMP_JSON.fields")"
SHA="$(sed -n '2p' "$TMP_JSON.fields")"

# Find this script's directory so install.sh can be invoked next to it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CLIENT=""
for candidate in "/Applications/哔哩哔哩.app" "/Applications/bilibili.app"; do
  if [[ -d "$candidate" ]]; then CLIENT="$candidate"; break; fi
done
if [[ -z "$CLIENT" ]]; then
  echo "请输入哔哩哔哩.app 的完整路径："
  read -r CLIENT
fi
if [[ ! -d "$CLIENT" ]]; then fail "客户端不存在: $CLIENT"; fi

exec "${SCRIPT_DIR}/install.sh" --update --client "$CLIENT" --version "$VERSION" --sha256 "$SHA" --progress "$@"