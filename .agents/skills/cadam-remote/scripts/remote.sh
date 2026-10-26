#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s --check | <single remote shell command>\n' "$0" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage

target='alpha@192.168.1.174'
options=(-o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=15)

if [[ $1 == --check ]]; then
  exec ssh "${options[@]}" "$target" 'printf "host=%s home=%s documents=%s\n" "$(hostname)" "$HOME" "$HOME/Documents"'
fi

exec ssh "${options[@]}" "$target" "$1"
