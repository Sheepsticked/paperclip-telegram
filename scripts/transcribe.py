#!/usr/bin/env python3
"""Transcribes one audio file offline, with faster-whisper or with Parakeet v3 (onnx-asr).

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

PARAKEET = "nemo-parakeet-tdt-0.6b-v3"
SAMPLE_RATE = 16000
# Parakeet reads long audio in pieces of up to a minute, which keeps its GPU memory near 3 GB.
CHUNK_SECONDS = 60
CHUNK_SEARCH_SECONDS = 10


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Transcribe an audio file offline.")
    parser.add_argument("audio", help="path of the audio file")
    parser.add_argument("--engine", choices=("whisper", "parakeet"), default="whisper", help="speech model family (default: whisper)")
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="cpu", help="where the model runs; auto tries the GPU first (default: cpu)")
    parser.add_argument("--model", default="small", help="Whisper model name or directory (default: small)")
    parser.add_argument("--models-dir", default=None, help="directory that holds the downloaded models")
    parser.add_argument("--threads", type=int, default=4, help="CPU threads (default: 4)")
    parser.add_argument("--beam", type=int, default=1, help="Whisper beam size (default: 1)")
    parser.add_argument("--language", default=None, help="fixed Whisper language code; detected when empty")
    return parser.parse_args(argv)


def whisper(args, device):
    from faster_whisper import WhisperModel

    model = WhisperModel(
        args.model,
        device=device,
        compute_type="int8" if device == "cpu" else "float16",
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
    return " ".join(segment.text.strip() for segment in segments).strip(), info.language


def decode(path):
    """The audio as 16 kHz mono float32 samples."""
    import av
    import numpy as np

    chunks = []
    with av.open(path) as container:
        resampler = av.AudioResampler(format="flt", layout="mono", rate=SAMPLE_RATE)
        for frame in container.decode(audio=0):
            chunks.extend(out.to_ndarray().reshape(-1) for out in resampler.resample(frame))
        chunks.extend(out.to_ndarray().reshape(-1) for out in resampler.resample(None))
    return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)


def pieces(samples, longest=CHUNK_SECONDS * SAMPLE_RATE):
    """Long audio cut into pieces of at most `longest` samples, each cut at the quietest tenth of a second
    in the last CHUNK_SEARCH_SECONDS before the limit, so words are rarely split."""
    import numpy as np

    frame = SAMPLE_RATE // 10
    start = 0
    while len(samples) - start > longest:
        window = samples[start + longest - CHUNK_SEARCH_SECONDS * SAMPLE_RATE:start + longest]
        frames = window[: len(window) // frame * frame].reshape(-1, frame)
        quietest = int(np.argmin((frames ** 2).mean(axis=1)))
        cut = start + longest - len(window) + quietest * frame + frame // 2
        yield samples[start:cut]
        start = cut
    yield samples[start:]


def parakeet(args, device):
    import onnx_asr
    import onnxruntime as ort

    if device == "cuda":
        ort.preload_dlls()
    options = ort.SessionOptions()
    options.intra_op_num_threads = args.threads
    providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if device == "cuda" else ["CPUExecutionProvider"]
    path = os.path.join(args.models_dir, "parakeet-v3") if args.models_dir else None
    model = onnx_asr.load_model(PARAKEET, path=path, providers=providers, sess_options=options)
    samples = decode(args.audio)
    # Audio shorter than a tenth of a second holds no speech.
    shortest = SAMPLE_RATE // 10
    texts = (model.recognize(piece, sample_rate=SAMPLE_RATE).strip() for piece in pieces(samples) if len(piece) >= shortest)
    return " ".join(text for text in texts if text), None


def transcribe(args):
    started = time.monotonic()
    run = parakeet if args.engine == "parakeet" else whisper
    if args.device == "auto":
        try:
            text, language = run(args, "cuda")
        except Exception as err:  # noqa: BLE001 - any GPU failure falls back to the CPU
            print(f"transcribe: GPU failed, using the CPU: {type(err).__name__}", file=sys.stderr)
            text, language = run(args, "cpu")
    else:
        text, language = run(args, args.device)
    return {"text": text, "language": language, "seconds": round(time.monotonic() - started, 1)}


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
