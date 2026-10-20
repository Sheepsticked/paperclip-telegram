#!/usr/bin/env python3
"""Transcribes one audio file with faster-whisper, offline.

Prints one JSON line on stdout: {"text", "language", "seconds"}, where seconds is the time the
transcription took. On failure it exits non-zero with a short message on stderr.
"""
import argparse
import json
import os
import sys
import time

# The model is read from disk only; the helper never uses the network.
os.environ["HF_HUB_OFFLINE"] = "1"


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Transcribe an audio file with faster-whisper.")
    parser.add_argument("audio", help="path of the audio file")
    parser.add_argument("--model", default="small", help="model name or directory (default: small)")
    parser.add_argument("--models-dir", default=None, help="directory that holds the downloaded models")
    parser.add_argument("--threads", type=int, default=4, help="CPU threads (default: 4)")
    parser.add_argument("--beam", type=int, default=1, help="beam size (default: 1)")
    parser.add_argument("--language", default=None, help="fixed language code; detected when empty")
    return parser.parse_args(argv)


def transcribe(args):
    from faster_whisper import WhisperModel

    started = time.monotonic()
    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        cpu_threads=args.threads,
        download_root=args.models_dir,
        local_files_only=True,
    )
    segments, info = model.transcribe(
        args.audio,
        beam_size=args.beam,
        language=args.language or None,
        vad_filter=True,
    )
    text = " ".join(segment.text.strip() for segment in segments).strip()
    return {
        "text": text,
        "language": info.language,
        "seconds": round(time.monotonic() - started, 1),
    }


def main(argv):
    args = parse_args(argv)
    if not os.path.isfile(args.audio):
        print("transcribe: audio file not found", file=sys.stderr)
        return 1
    # Anything a library prints along the way must not end up in the JSON line.
    out, sys.stdout = sys.stdout, sys.stderr
    try:
        result = transcribe(args)
    except Exception as err:  # noqa: BLE001 - one short message is all the caller needs
        message = " ".join(str(err).split())[:200]
        print(f"transcribe: {type(err).__name__}: {message}", file=sys.stderr)
        return 1
    finally:
        sys.stdout = out
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
