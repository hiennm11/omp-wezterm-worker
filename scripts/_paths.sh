#!/usr/bin/env bash
# Shared path helpers for the omp-wezterm-worker scripts.
#
# Two rules drive everything here:
#
#  1. OMP is a native Windows process. Every path handed to it must be a
#     Windows path. Git Bash reports POSIX paths (/mnt/c/..., /home/<user>)
#     that OMP resolves to a non-existent location and then silently skips.
#
#  2. OMP's plugin linker resolves a plugin path against its own working
#     directory. When that directory is reported as a POSIX path and the
#     argument is a Windows path, the two are joined and the lookup fails
#     ("package.json not found at <cwd>/<arg>"). Linking with a relative path
#     from the repo root avoids the clash entirely.

# to_win_path <path> -> Windows path with forward slashes
#
# Handles the path shapes this project actually sees:
#   C:\Users\<you>       (native Windows)
#   C:/Users/<you>       (already converted)
#   /d/repos/x           (Git Bash drive-root form)
#   /mnt/d/repos/x       (MSYS-style drive mount)
#   /home/user           (MSYS home)
to_win_path() {
	local p="$1"
	local converted=""

	case "$p" in
		[A-Za-z]:[\\/]*)
			# Already a Windows path.
			converted="$p"
			;;
		/mnt/[a-z]/*)
			# MSYS-style mount: /mnt/d/x -> D:/x
			local drive="${p#/mnt/}"
			drive="${drive%%/*}"
			local rest="${p#/mnt/[a-z]}"
			converted="$(printf '%s' "$drive" | tr '[:lower:]' '[:upper:]'):/${rest#/}"
			;;
		/[a-z]/*)
			# Git Bash drive-root form: /d/x -> D:/x
			local drive="${p#/}"
			drive="${drive%%/*}"
			local rest="${p#/[a-z]}"
			converted="$(printf '%s' "$drive" | tr '[:lower:]' '[:upper:]'):/${rest#/}"
			;;
		/*)
			# Some other absolute POSIX path: fall back to cygpath, then to
			# the path unchanged.
			if command -v cygpath >/dev/null 2>&1; then
				converted="$(cygpath -m "$p" 2>/dev/null || printf '%s' "$p")"
			else
				converted="$p"
			fi
			;;
		*)
			converted="$p"
			;;
	esac

	# Normalize backslashes to forward slashes. OMP's linker mishandles a
	# backslash path when its cwd is reported as a Windows path.
	printf '%s\n' "${converted//\\//}"
}

# home_dir -> the user's home directory as a Windows path
#
# Git Bash sets HOME to a synthetic MSYS path ("/home/<user>") that does not
# exist on the Windows filesystem, and it does not always export USERPROFILE
# to child processes. So the environment is only a fallback: the authoritative
# source is `omp config path`, which reports the real agent directory.
home_dir() {
	if command -v omp >/dev/null 2>&1; then
		local agent_dir
		agent_dir="$(omp config path 2>/dev/null | tr -d '\r' | head -1)"
		# The agent dir is <home>/.omp/agent; the home is two levels up.
		case "$agent_dir" in
			*:*/.omp/agent)
				local win_agent
				win_agent="$(to_win_path "$agent_dir")"
				printf '%s\n' "${win_agent%/.omp/agent}"
				return
				;;
		esac
	fi
	if [ -n "${USERPROFILE:-}" ]; then
		to_win_path "$USERPROFILE"
		return
	fi
	if [ -n "${HOMEDRIVE:-}" ] && [ -n "${HOMEPATH:-}" ]; then
		to_win_path "${HOMEDRIVE}${HOMEPATH}"
		return
	fi
	if [ -n "${HOME:-}" ]; then
		to_win_path "$HOME"
		return
	fi
	to_win_path "$PWD"
}
