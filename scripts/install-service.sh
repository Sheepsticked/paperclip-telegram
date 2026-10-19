#!/usr/bin/env bash
# Writes the systemd user unit for this checkout. Enabling and starting it is left to the caller.
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
node_bin=$(command -v node) || { echo "install-service: node is not on PATH" >&2; exit 1; }
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit_file="$unit_dir/paperclip-telegram.service"

# Unit files split ExecStart on spaces, so refuse paths that would be misread.
for value in "$node_bin" "$repo_dir"; do
  case "$value" in
    *[[:space:]\"\'\\]*) echo "install-service: path contains whitespace, a quote or a backslash: $value" >&2; exit 1 ;;
  esac
done

template=$(<"$repo_dir/systemd/paperclip-telegram.service.in")
# A literal % must be doubled in a unit file.
unit=${template//@NODE@/${node_bin//%/%%}}
unit=${unit//@REPO_DIR@/${repo_dir//%/%%}}

mkdir -p "$unit_dir"
printf '%s\n' "$unit" >"$unit_file"
echo "wrote $unit_file"

# Create the state dir up front: if it is missing and a config dir of the same name exists,
# systemd links the state dir to the config dir and the state ends up beside the tokens.
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/paperclip-telegram"
mkdir -p "$state_dir"
chmod 700 "$state_dir"

if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze --user verify "$unit_file"
fi

cat <<'MSG'
next:
  systemctl --user daemon-reload
  systemctl --user enable paperclip-telegram
  systemctl --user start paperclip-telegram
MSG
