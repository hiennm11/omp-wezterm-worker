#!/usr/bin/env bash
# Move an OMP session into another working directory.
#
# A session file that a live omp process owns cannot be packed or moved by
# another process. The interactive `/move` command needs a confirmation picker
# that cannot be driven from a script. This script therefore resumes the
# transcript in a short-lived omp process and moves it from there, which is
# the documented SessionManager.moveTo(cwd) path.
#
# Usage:
#   ./scripts/move-session.sh <session-file-or-id> <target-dir>
#   ./scripts/move-session.sh --latest <target-dir>     # newest session of this cwd
#
# The target directory is created if it does not exist.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/_paths.sh
. "$(dirname "${BASH_SOURCE[0]}")/_paths.sh"

if [ "${OS:-}" != "Windows_NT" ]; then
	echo "error: this script needs a Windows bash (Git Bash or MSYS2)." >&2
	echo "       Detected: $(uname -s 2>/dev/null || echo unknown)" >&2
	exit 1
fi

OMP_BIN="${OMP_BIN:-omp}"
SESSION_ARG=""
TARGET=""

while [ $# -gt 0 ]; do
	case "$1" in
		--latest)
			SESSION_ARG="--latest"
			shift
			;;
		-h | --help)
			sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*)
			if [ -z "$SESSION_ARG" ]; then
				SESSION_ARG="$1"
			else
				TARGET="$1"
			fi
			shift
			;;
	esac
done

if [ -z "$SESSION_ARG" ] || [ -z "$TARGET" ]; then
	echo "usage: $0 <session-file-or-id> <target-dir>" >&2
	echo "       $0 --latest <target-dir>" >&2
	exit 2
fi

TARGET_WIN="$(to_win_path "$TARGET")"
mkdir -p "$TARGET_WIN"

RESUME_ARGS=()
if [ "$SESSION_ARG" = "--latest" ]; then
	# Let omp pick the newest resumable session for the current directory.
	RESUME_ARGS=(--continue)
else
	RESUME_ARGS=(--resume "$(to_win_path "$SESSION_ARG")")
fi

echo "==> Moving session into $TARGET_WIN"
echo "    (the session must not be owned by a running omp process)"

OUTPUT="$(OMP_MOVE_TARGET="$TARGET_WIN" "$OMP_BIN" --mode rpc --no-ui --no-title \
	--cwd "$TARGET_WIN" "${RESUME_ARGS[@]}" \
	-e "$(to_win_path "$REPO_ROOT/scripts/move-session.ts")" 2>&1 || true)"

printf '%s\n' "$OUTPUT" | grep -E "MOVE_(BEFORE|AFTER|RESULT|ERROR|CWD)" | sed 's/^/    /' || true

if printf '%s\n' "$OUTPUT" | grep -q "MOVE_AFTER"; then
	echo
	echo "Moved. Resume it in the new project with:"
	echo "  omp --resume <session-id>"
else
	echo
	echo "Move did not complete. Common causes:" >&2
	echo "  - another omp process still owns that session (close it first)" >&2
	echo "  - the session file does not exist" >&2
	exit 1
fi
