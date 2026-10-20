#!/usr/bin/env bash
# Sets up local speech-to-text for voice notes: a Python venv with faster-whisper and the "small" model.
# Safe to run again. Prints the "voice" block to add to the bot config.
set -euo pipefail

data_dir="${XDG_DATA_HOME:-$HOME/.local/share}/paperclip-telegram/voice"
models_dir="$data_dir/models"
python_bin="$data_dir/bin/python"
model="small"

command -v python3 >/dev/null 2>&1 || { echo "install-voice: python3 is not on PATH" >&2; exit 1; }

if [ ! -x "$python_bin" ]; then
  python3 -m venv "$data_dir" || { echo "install-voice: could not create the venv (is python3-venv installed?)" >&2; exit 1; }
fi

# PyAV 16 and later break faster-whisper 1.2.1, so it stays below 16.
"$python_bin" -m pip install --quiet --disable-pip-version-check --no-input "faster-whisper==1.2.1" "av>=15,<16"

mkdir -p "$models_dir"
# The download is skipped when the model is already on disk.
"$python_bin" - "$models_dir" "$model" <<'PY'
import sys
from faster_whisper import download_model

models_dir, model = sys.argv[1], sys.argv[2]
try:
    download_model(model, cache_dir=models_dir, local_files_only=True)
    print(f"model {model} is already in {models_dir}")
except Exception:
    print(f"downloading model {model} to {models_dir}", flush=True)
    download_model(model, cache_dir=models_dir)
PY

cat <<MSG

Add this to the bot config (the "voice" key), then restart the service:

  "voice": {
    "python": "$python_bin",
    "modelsDir": "$models_dir",
    "model": "$model",
    "language": null,
    "beamSize": 1,
    "threads": 4,
    "maxSeconds": 300
  }
MSG
