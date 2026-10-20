#!/usr/bin/env bash
# Uninstall omp-wezterm-worker.
#
# Unlinks the plugin from the OMP registry, removes the config file and the
# runtime state directory. Never touches OMP core files or other plugins.
#
# Usage:
#   ./scripts/uninstall.sh              # unlink + remove config + remove state
#   ./scripts/uninstall.sh --keep-state # keep the runtime state directory
#   ./scripts/uninstall.sh --keep-config
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/_paths.sh
. "$(dirname "${BASH_SOURCE[0]}")/_paths.sh"

# This script must run in a Windows bash (Git Bash / MSYS2). Under WSL the
# `omp` on PATH is the Linux build and it would modify the wrong OMP install.
if [ "${OS:-}" != "Windows_NT" ]; then
	echo "error: this script needs a Windows bash (Git Bash or MSYS2)." >&2
	echo "       Detected: $(uname -s 2>/dev/null || echo unknown)" >&2
	echo "       Run it from Git Bash, e.g.:" >&2
	echo "         'C:/Program Files/Git/bin/bash.exe' scripts/uninstall.sh" >&2
	exit 1
fi

OMP_BIN="${OMP_BIN:-omp}"
# OMP runs as a native Windows process, so every path handed to it must be a
# Windows path. Git Bash reports /mnt/c/... and /home/<user>, which OMP
# resolves to a non-existent location and silently skips.
if [ -n "${OMP_AGENT_DIR:-}" ]; then
	AGENT_DIR="$(to_win_path "$OMP_AGENT_DIR")"
elif [ -n "$("$OMP_BIN" config path 2>/dev/null | tr -d '\r' | head -1)" ]; then
	AGENT_DIR="$(to_win_path "$("$OMP_BIN" config path 2>/dev/null | tr -d '\r' | head -1)")"
else
	AGENT_DIR="$(home_dir)/.omp/agent"
fi
PLUGIN_DIR="$(dirname "$AGENT_DIR")/plugins"
CONFIG_FILE="$AGENT_DIR/wezterm-worker.json"
STATE_DIR="$AGENT_DIR/wezterm-workers"
KEEP_STATE=0
KEEP_CONFIG=0

for arg in "$@"; do
	case "$arg" in
		--keep-state) KEEP_STATE=1 ;;
		--keep-config) KEEP_CONFIG=1 ;;
		-h | --help)
			sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*)
			echo "unknown option: $arg" >&2
			exit 2
			;;
	esac
done

if ! command -v "$OMP_BIN" >/dev/null 2>&1; then
	echo "error: '$OMP_BIN' not found on PATH." >&2
	exit 1
fi

PKG_NAME="omp-wezterm-worker"

echo "==> Unlinking $PKG_NAME from the OMP plugin registry"
if "$OMP_BIN" plugin list 2>/dev/null | grep -q "$PKG_NAME"; then
	"$OMP_BIN" plugin uninstall "$PKG_NAME" || {
		echo "warning: 'omp plugin uninstall' failed; removing the link by hand" >&2
		rm -rf "$PLUGIN_DIR/node_modules/$PKG_NAME" 2>/dev/null || true
	}
else
	echo "    (not registered, skipping)"
	rm -rf "$PLUGIN_DIR/node_modules/$PKG_NAME" 2>/dev/null || true
fi

if [ "$KEEP_CONFIG" -eq 0 ]; then
	if [ -f "$CONFIG_FILE" ]; then
		echo "==> Removing $CONFIG_FILE"
		rm -f "$CONFIG_FILE"
	else
		echo "==> No config file at $CONFIG_FILE"
	fi
else
	echo "==> Keeping config: $CONFIG_FILE"
fi

if [ "$KEEP_STATE" -eq 0 ]; then
	if [ -d "$STATE_DIR" ]; then
		echo "==> Removing state directory $STATE_DIR"
		rm -rf "$STATE_DIR"
	else
		echo "==> No state directory at $STATE_DIR"
	fi
else
	echo "==> Keeping state: $STATE_DIR"
fi

echo
echo "Uninstalled."
echo "Note: worker panes that are still running keep their OMP process alive."
echo "Close them from WezTerm, or run: wezterm cli list"
