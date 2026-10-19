#!/usr/bin/env bash
# BTR Desktop macOS installer. The Windows installer is a PowerShell script; this bash
# equivalent covers the same actions (install, update, reconnect, uninstall) and prints
# JSON progress lines that the in-client renderer can poll.
#
# Usage:
#   install.sh                                              # first-time install
#   install.sh --client /Applications/哔哩哔哩.app          # explicit client
#   install.sh --update --client <path> --version <ver> --sha256 <hex>
#   install.sh --reconnect --client <path>
#   install.sh --uninstall --client <path>
#   install.sh --no-launch                                  # do not relaunch the client
#
# Progress reporting: the in-client renderer needs to know when the operation finishes. The
# launcher writes a single JSON line to BTR_INSTALL_DIR/last-result.json on completion and
# also streams BTR_PROGRESS lines to stdout when --progress is passed.
set -euo pipefail

# Resolve the directory holding BTR_Desktop, BTR_Guard, install.sh, etc.
BTR_SCRIPT_PATH="${BASH_SOURCE[0]}"
if [[ -L "$BTR_SCRIPT_PATH" ]]; then BTR_SCRIPT_PATH="$(readlink -f "$BTR_SCRIPT_PATH")"; fi
BTR_INSTALL_DIR="$(cd "$(dirname "$BTR_SCRIPT_PATH")" && pwd)"
if [[ ! -f "${BTR_INSTALL_DIR}/BTR_Desktop.cjs" ]]; then
  echo "BTR_INSTALL_DIR=${BTR_INSTALL_DIR} does not look like a BTR install" >&2
  exit 1
fi
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"

LAST_RESULT="${BTR_INSTALL_DIR}/last-result.json"
PROGRESS=0
NO_LAUNCH=0
ACTION="install"
CLIENT_PATH=""
EXPECTED_VERSION=""
EXPECTED_SHA256=""

write_result() {
  local exit_code=$1
  local message=$2
  local state=$3
  # Atomic write: BTR_Desktop's in-client spawn polls this file.
  if ! { printf '{"exit":%d,"state":"%s","message":"%s"}\n' "$exit_code" "$state" "${message//\"/\\\"}" > "$LAST_RESULT.tmp" && mv "$LAST_RESULT.tmp" "$LAST_RESULT"; } 2>/dev/null; then
    # Fallback: use a writable directory if the install dir is read-only.
    local fallback="${HOME}/Library/Application Support/BTR_Desktop/last-result.json"
    mkdir -p "$(dirname "$fallback")"
    printf '{"exit":%d,"state":"%s","message":"%s"}\n' "$exit_code" "$state" "${message//\"/\\\"}" > "$fallback"
  fi
}

progress() {
  if (( PROGRESS )); then printf 'BTR_PROGRESS %s\n' "$1"; fi
}

fail() {
  local message=$1
  echo "$message" >&2
  write_result 1 "$message" "error"
  exit 1
}

while (( $# > 0 )); do
  case "$1" in
    --client) CLIENT_PATH="$2"; shift 2;;
    --reconnect) ACTION="repair"; shift;;
    --uninstall) ACTION="uninstall"; shift;;
    --update) ACTION="update"; shift;;
    --no-launch) NO_LAUNCH=1; shift;;
    --progress) PROGRESS=1; shift;;
    --version) EXPECTED_VERSION="$2"; shift 2;;
    --sha256) EXPECTED_SHA256="$2"; shift 2;;
    --noninteractive) shift;;
    --help|-h)
      echo "Usage: install.sh [--client <path>] [--reconnect|--update|--uninstall] [--no-launch] [--progress] [--version <ver>] [--sha256 <hex>] [--noninteractive]"
      exit 0;;
    *) fail "未知参数: $1";;
  esac
done

run_desktop() {
  # node is bundled with macOS installs only on newer versions; /usr/bin/env node is fine
  # because BTR is installed on systems that have Node from Homebrew or from the system.
  if command -v node >/dev/null 2>&1; then
    /usr/bin/env node "${BTR_INSTALL_DIR}/BTR_Desktop.cjs" "$@"
  else
    fail "需要 node（macOS 上请运行 brew install node）"
  fi
}

find_client() {
  if [[ -n "$CLIENT_PATH" ]]; then
    if [[ ! -d "$CLIENT_PATH" ]]; then fail "客户端路径不存在: $CLIENT_PATH"; fi
    printf '%s\n' "$CLIENT_PATH"
    return 0
  fi
  for candidate in "/Applications/哔哩哔哩.app" "/Applications/bilibili.app"; do
    if [[ -d "$candidate" ]] && [[ -f "$candidate/Contents/Resources/app.asar" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo ""
}

CLIENT_PATH_RESOLVED="$(find_client)"
if [[ -z "$CLIENT_PATH_RESOLVED" ]]; then
  if [[ -n "$CLIENT_PATH" ]]; then fail "找不到哔哩哔哩.app，请确认 --client 指向客户端安装位置"; fi
  echo "没有在默认位置找到哔哩哔哩。请输入客户端 .app 的完整路径（或把 哔哩哔哩.app 拖进窗口）:" >&2
  read -r CLIENT_PATH_RESOLVED
  CLIENT_PATH_RESOLVED="${CLIENT_PATH_RESOLVED%\"}"; CLIENT_PATH_RESOLVED="${CLIENT_PATH_RESOLVED#\"}"
  CLIENT_PATH_RESOLVED="${CLIENT_PATH_RESOLVED%/}"
  if [[ -z "$CLIENT_PATH_RESOLVED" ]] || [[ ! -d "$CLIENT_PATH_RESOLVED" ]]; then fail "未找到哔哩哔哩客户端"; fi
  if [[ ! -f "$CLIENT_PATH_RESOLVED/Contents/Resources/app.asar" ]]; then fail "目标不是官方哔哩哔哩客户端（缺少 Contents/Resources/app.asar）"; fi
fi

progress "manifest"
STATUS_JSON="$(run_desktop status --client "$CLIENT_PATH_RESOLVED" 2>/dev/null || true)"
if [[ -z "$STATUS_JSON" ]] || ! echo "$STATUS_JSON" | grep -q '"supported":'; then
  fail "无法读取客户端。"
fi
if ! echo "$STATUS_JSON" | grep -q '"supported": true'; then
  CLIENT_VERSION="$(echo "$STATUS_JSON" | sed -n 's/.*"clientVersion": *"\([^"]*\)".*/\1/p')"
  fail "无法识别客户端 ${CLIENT_VERSION:-unknown} 的入口结构，没有修改官方文件"
fi

case "$ACTION" in
  install)
    progress "closing"
    # Close any running Bilibili instance that points at the same .app.
    if pgrep -f "哔哩哔哩\\.app/Contents/MacOS/哔哩哔哩" >/dev/null 2>&1; then
      pkill -TERM -f "哔哩哔哩\\.app/Contents/MacOS/哔哩哔哩" || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        sleep 0.5
        pgrep -f "哔哩哔哩\\.app/Contents/MacOS/哔哩哔哩" >/dev/null 2>&1 || break
      done
      pgrep -f "哔哩哔哩\\.app/Contents/MacOS/哔哩哔哩" >/dev/null 2>&1 && pkill -KILL -f "哔哩哔哩\\.app/Contents/MacOS/哔哩哔哩" || true
    fi
    progress "install"
    INSTALL_JSON="$(run_desktop install --client "$CLIENT_PATH_RESOLVED" 2>&1)" || true
    if ! echo "$INSTALL_JSON" | grep -q '"state": "installed"'; then
      fail "安装失败：$(echo "$INSTALL_JSON" | sed -n 's/.*"message": *"\([^"]*\)".*/\1/p' | head -n1)"
    fi
    if (( NO_LAUNCH == 0 )); then
      progress "restart"
      open "$CLIENT_PATH_RESOLVED"
    fi
    progress "complete"
    write_result 0 "BTR 安装完成" "installed"
    ;;

  repair|update)
    progress "closing"
    pkill -TERM -f "哔哩哔哩\\.app/Contents/MacOS/哔哩哔哩" || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      sleep 0.5
      pgrep -f "哔哩哔哩\\.app/Contents/MacOS/哔哩哔哩" >/dev/null 2>&1 || break
    done
    pkill -KILL -f "哔哩哔哩\\.app/Contents/MacOS/哔哩哔哩" || true
    progress "repair"
    REPAIR_JSON="$(run_desktop repair --client "$CLIENT_PATH_RESOLVED" 2>&1)" || true
    if ! echo "$REPAIR_JSON" | grep -q '"state": "installed"'; then
      fail "重新接入失败：$(echo "$REPAIR_JSON" | sed -n 's/.*"message": *"\([^"]*\)".*/\1/p' | head -n1)"
    fi
    if (( NO_LAUNCH == 0 )); then
      progress "restart"
      open "$CLIENT_PATH_RESOLVED"
    fi
    progress "complete"
    write_result 0 "BTR 已重新接入" "reconnected"
    ;;

  uninstall)
    progress "closing"
    pkill -TERM -f "哔哩哔哩\\.app/Contents/MacOS/哔哩哔哩" || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      sleep 0.5
      pgrep -f "哔哩哔哩\\.app/Contents/MacOS/哔哩哔哩" >/dev/null 2>&1 || break
    done
    progress "restore"
    REMOVE_JSON="$(run_desktop remove --client "$CLIENT_PATH_RESOLVED" --keep-record 2>&1)" || true
    if ! echo "$REMOVE_JSON" | grep -q '"state": "removed"'; then
      fail "卸载失败：$(echo "$REMOVE_JSON" | sed -n 's/.*"message": *"\([^"]*\)".*/\1/p' | head -n1)"
    fi
    progress "cleanup"
    /usr/bin/env node "${BTR_INSTALL_DIR}/BTR_Guard.cjs" guard --unregister || true
    if (( NO_LAUNCH == 0 )); then
      progress "restart"
      open "$CLIENT_PATH_RESOLVED"
    fi
    progress "complete"
    write_result 0 "BTR 已卸载" "removed"
    ;;

  *)
    fail "未知操作: $ACTION"
    ;;
esac

exit 0