#!/usr/bin/env bash
# Install omp-wezterm-worker.
#
# Links this repo into the OMP plugin registry so OMP loads the extension from
# `extensions/wezterm-worker.ts` on every start. Creates a default config file
# if none exists.
#
# Usage:
#   ./scripts/install.sh              # link + write a default config
#   ./scripts/install.sh --no-config  # link only
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/_paths.sh
. "$(dirname "${BASH_SOURCE[0]}")/_paths.sh"

# This script must run in a Windows bash (Git Bash / MSYS2). Under WSL the
# `omp` on PATH is the Linux build, it reports a Linux agent directory, and
# `omp plugin link` would modify the wrong OMP installation.
if [ "${OS:-}" != "Windows_NT" ]; then
	echo "error: this script needs a Windows bash (Git Bash or MSYS2)." >&2
	echo "       Detected: $(uname -s 2>/dev/null || echo unknown)" >&2
	echo "       Run it from Git Bash, e.g.:" >&2
	echo "         'C:/Program Files/Git/bin/bash.exe' scripts/install.sh" >&2
	exit 1
fi

OMP_BIN="${OMP_BIN:-omp}"
# OMP runs as a native Windows process, so every path handed to it must be a
# Windows path. Git Bash reports POSIX paths (/mnt/c/..., /home/<user>) that
# OMP resolves to a non-existent location and silently skips.
#
# `omp config path` is the authoritative source for the agent directory: it
# accounts for profiles and PI_CODING_AGENT_DIR, which no environment variable
# does. The env is only a fallback.
if [ -n "${OMP_AGENT_DIR:-}" ]; then
	AGENT_DIR="$(to_win_path "$OMP_AGENT_DIR")"
elif [ -n "$("$OMP_BIN" config path 2>/dev/null | tr -d '\r' | head -1)" ]; then
	AGENT_DIR="$(to_win_path "$("$OMP_BIN" config path 2>/dev/null | tr -d '\r' | head -1)")"
else
	AGENT_DIR="$(home_dir)/.omp/agent"
fi
REPO_ROOT_WIN="$(to_win_path "$REPO_ROOT")"
CONFIG_FILE="$AGENT_DIR/wezterm-worker.json"
WRITE_CONFIG=1

for arg in "$@"; do
	case "$arg" in
		--no-config) WRITE_CONFIG=0 ;;
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
	echo "Install OMP first, or set OMP_BIN to its full path." >&2
	exit 1
fi

if ! command -v wezterm >/dev/null 2>&1 && [ ! -x "/c/Program Files/WezTerm/wezterm.exe" ]; then
	echo "warning: 'wezterm' not found on PATH." >&2
	echo "         The extension will still install, but spawning a worker will fail." >&2
	echo "         Add 'C:\\Program Files\\WezTerm' to PATH, or set weztermBin in the config." >&2
fi

echo "==> Linking $REPO_ROOT_WIN into the OMP plugin registry"
# Link with the relative path "." from the repo root. OMP resolves a plugin
# path against its own working directory, and that directory may be reported
# as a POSIX path ("/mnt/d/...") while the argument is a Windows path
# ("D:/..."). Joining the two yields a path that does not exist, and the
# linker then silently skips the install. A relative path has no such clash.
(cd "$REPO_ROOT" && "$OMP_BIN" plugin link ".")

# Install the companion skill. The skill carries the operating knowledge that
# is not in the extension: how to deliver Enter to a pane, how to relocate a
# session, and the Windows shell traps. A copy in the agent skills directory
# is picked up on the next session start.
SKILL_SRC="$REPO_ROOT/skills/wezterm-omp-pane-ops/SKILL.md"
SKILL_DIR="$AGENT_DIR/skills/wezterm-omp-pane-ops"
if [ -f "$SKILL_SRC" ]; then
	mkdir -p "$SKILL_DIR"
	cp "$SKILL_SRC" "$SKILL_DIR/SKILL.md"
	echo "==> Installed skill: $SKILL_DIR/SKILL.md"
else
	echo "==> Skill source not found, skipped: $SKILL_SRC" >&2
fi

if [ "$WRITE_CONFIG" -eq 1 ]; then
	if [ -f "$CONFIG_FILE" ]; then
		echo "==> Config already exists, left untouched: $CONFIG_FILE"
	else
		echo "==> Writing default config: $CONFIG_FILE"
		mkdir -p "$AGENT_DIR"
		cat >"$CONFIG_FILE" <<EOF
{
	"ompBin": "$OMP_BIN",
	"weztermBin": "wezterm",
	"placement": "split",
	"stateDir": "$AGENT_DIR/wezterm-workers",
	"defaultCwd": "$(to_win_path "$PWD")",
	"model": null,
	"tools": null,
	"pollMs": 2000,
	"timeoutMs": 1800000,
	"idleTimeoutMs": 0,
	"isolated": false
}
EOF
	fi
fi

echo
echo "Installed."
echo "  extension : $REPO_ROOT_WIN/extensions/wezterm-worker.ts"
echo "  config    : $CONFIG_FILE"
echo
echo "Start a new OMP session, then check the tools are live:"
echo "  /wezterm-workers"
echo
echo "To uninstall: ./scripts/uninstall.sh"
