#!/usr/bin/env bash
# Sets up local speech-to-text for voice notes: a Python venv with faster-whisper and a Whisper model ("small" by default),
# or with VOICE_ENGINE=parakeet a venv with onnx-asr and Parakeet v3, set to use the GPU when nvidia-smi finds one.
# Safe to run again. VOICE_DIR and WHISPER_MODEL change the folder and the model. Prints the "voice" block to add to the bot config.
set -euo pipefail

engine="${VOICE_ENGINE:-whisper}"
case "$engine" in
  whisper) default_dir=voice ;;
  parakeet) default_dir=voice-parakeet ;;
  *) echo "install-voice: VOICE_ENGINE must be whisper or parakeet" >&2; exit 1 ;;
esac
data_dir="${VOICE_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/paperclip-telegram/$default_dir}"
models_dir="$data_dir/models"
python_bin="$data_dir/bin/python"
model="${WHISPER_MODEL:-small}"

command -v python3 >/dev/null 2>&1 || { echo "install-voice: python3 is not on PATH" >&2; exit 1; }

if [ ! -x "$python_bin" ]; then
  python3 -m venv "$data_dir" || { echo "install-voice: could not create the venv (is python3-venv installed?)" >&2; exit 1; }
fi

if [ "$engine" = parakeet ]; then
  device=cpu
  runtime="onnxruntime==1.31.1"
  if nvidia-smi >/dev/null 2>&1; then
    device=auto
    runtime="onnxruntime-gpu[cuda,cudnn]==1.31.1"
  fi
  "$python_bin" -m pip install --quiet --disable-pip-version-check --no-input "onnx-asr[hub]==0.12.0" "$runtime" "av>=15,<17"
  mkdir -p "$models_dir"
  # The first load downloads the model into its folder; later loads only read it.
  "$python_bin" -c 'import sys, onnx_asr; onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v3", path=sys.argv[1], providers=["CPUExecutionProvider"])' "$models_dir/parakeet-v3"
  cat <<MSG

Add this to the bot config (the "voice" key), then restart the service:

  "voice": {
    "python": "$python_bin",
    "modelsDir": "$models_dir",
    "engine": "parakeet",
    "device": "$device",
    "threads": 4,
    "maxSeconds": 300
  }
MSG
  exit 0
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
