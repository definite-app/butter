#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = [
#   "numpy>=2.0",
#   "sherpa-onnx>=1.13.8,<1.14",
#   "parakeet-mlx>=0.5.3,<0.6; sys_platform == 'darwin' and platform_machine == 'arm64'",
# ]
# ///
"""butter-rec speech-to-text worker.

Engines:
  parakeet  NVIDIA Parakeet TDT 0.6B via parakeet-mlx (Apple Silicon / MLX)
  canary    NVIDIA Canary 180M Flash via sherpa-onnx (int8 ONNX, CPU)
  whisper   whisper.cpp `whisper-cli` subprocess (ggml models)

Modes:
  worker.py serve                      JSON lines on stdin -> JSON lines on stdout
  worker.py transcribe <wav> [opts]    one-shot, prints text (or JSON with --json)

stdout carries ONLY protocol JSON (fd 1 is re-pointed at stderr at startup so
stray prints from native libraries can't corrupt it). Logs go to stderr.

Models are downloaded on first use into ~/.butter/models (override with
BUTTER_MODELS_DIR). All model work runs on the main thread (MLX streams are
thread-local); a reader thread feeds requests in. Long jobs are cooperative
generators that yield between chunks, so a short dictation request submitted
while a long meeting is transcribing gets serviced between chunks instead of
waiting for the whole meeting.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Generator

import numpy as np

SR = 16000
MODELS_DIR = Path(os.environ.get("BUTTER_MODELS_DIR", "~/.butter/models")).expanduser()

# Request `vad` omitted/null: VAD on when audio is longer than this.
AUTO_VAD_MIN_SECONDS = 30.0

DEFAULT_MODELS = {
    "parakeet": "mlx-community/parakeet-tdt-0.6b-v2",
    "canary": "sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8",
    "whisper": "small.en",
}
PARAKEET_ALIASES = {
    "v2": "mlx-community/parakeet-tdt-0.6b-v2",
    "v3": "mlx-community/parakeet-tdt-0.6b-v3",
    "parakeet-tdt-0.6b-v2": "mlx-community/parakeet-tdt-0.6b-v2",
    "parakeet-tdt-0.6b-v3": "mlx-community/parakeet-tdt-0.6b-v3",
}
CANARY_ALIASES = {
    "canary-180m-flash": "sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8",
    "int8": "sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8",
    "canary-180m-flash-fp32": "sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr",
    "fp32": "sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr",
}
CANARY_LANGS = {"en", "es", "de", "fr"}
SHERPA_RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
WHISPER_GGML_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{name}.bin"
WHISPER_VAD_NAME = "ggml-silero-v6.2.0.bin"
WHISPER_VAD_URL = f"https://huggingface.co/ggml-org/whisper-vad/resolve/main/{WHISPER_VAD_NAME}"
WHISPER_SEARCH_DIRS = [
    MODELS_DIR / "whisper",
    Path("~/.cache/whisper").expanduser(),
    Path("~/.local/share/paper/models").expanduser(),
    Path("/opt/homebrew/share/whisper-cpp"),
]

# Per-engine VAD windowing: speech regions separated by < merge_gap seconds are
# decoded together, up to max_window seconds per decode.
VAD_PARAMS = {
    "parakeet": {"merge_gap": 2.0, "max_window": 60.0},
    "canary": {"merge_gap": 0.8, "max_window": 20.0},
}
VAD_PAD = 0.25  # seconds of context kept on each side of a speech region
CANARY_MAX_CHUNK = 25.0  # canary-180m-flash degrades past ~30-40s; no-VAD long input is cut at quiet points
PARAKEET_CHUNK = 120.0  # no-VAD long input: parakeet-mlx style overlapping chunks
PARAKEET_OVERLAP = 15.0

WAIT = object()  # yielded by a job that is blocked on a subprocess


class RequestError(Exception):
    pass


def log(*args: Any) -> None:
    print("[asr]", *args, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Audio


@dataclass
class Audio:
    samples: np.ndarray  # int16 or float32, mono 16 kHz (usually a memmap)
    path: str
    _tmp: str | None = None

    @property
    def duration(self) -> float:
        return len(self.samples) / SR

    def f32(self, start: int = 0, end: int | None = None) -> np.ndarray:
        x = self.samples[start:end]
        if x.dtype == np.int16:
            return x.astype(np.float32) / 32768.0
        return np.asarray(x, dtype=np.float32)


def _wav_layout(path: str) -> tuple[tuple[int, int, int, int], int, int] | None:
    """Return ((format, channels, rate, bits), data_offset, data_bytes) or None."""
    fsize = os.path.getsize(path)
    with open(path, "rb") as f:
        head = f.read(12)
        if len(head) < 12 or head[:4] not in (b"RIFF", b"RF64") or head[8:12] != b"WAVE":
            return None
        fmt = None
        while True:
            hdr = f.read(8)
            if len(hdr) < 8:
                return None
            cid, size = hdr[:4], struct.unpack("<I", hdr[4:])[0]
            if cid == b"fmt ":
                data = f.read(size)
                tag, ch, rate, _, _, bits = struct.unpack("<HHIIHH", data[:16])
                if tag == 0xFFFE and size >= 26:  # WAVE_FORMAT_EXTENSIBLE
                    tag = struct.unpack("<H", data[24:26])[0]
                fmt = (tag, ch, rate, bits)
                if size & 1:
                    f.read(1)
            elif cid == b"data":
                off = f.tell()
                # RF64, or a file still being written, can carry a bogus size
                if size in (0, 0xFFFFFFFF) or off + size > fsize:
                    size = fsize - off
                return (fmt, off, size) if fmt else None
            else:
                f.seek(size + (size & 1), 1)


def load_audio(path: str) -> Audio:
    if not os.path.isfile(path):
        raise RequestError(f"audio not found: {path}")
    layout = _wav_layout(path)
    if layout:
        (tag, ch, rate, bits), off, size = layout
        if ch == 1 and rate == SR and tag == 1 and bits == 16:
            n = size // 2
            arr = np.memmap(path, dtype="<i2", mode="r", offset=off, shape=(n,)) if n else np.zeros(0, np.int16)
            return Audio(arr, path)
        if ch == 1 and rate == SR and tag == 3 and bits == 32:
            n = size // 4
            arr = np.memmap(path, dtype="<f4", mode="r", offset=off, shape=(n,)) if n else np.zeros(0, np.float32)
            return Audio(arr, path)
    # Anything else: let ffmpeg convert to 16k mono s16 in a temp file
    if not shutil.which("ffmpeg"):
        raise RequestError(f"{path} is not 16 kHz mono 16-bit WAV and ffmpeg is not installed")
    fd, tmp = tempfile.mkstemp(suffix=".s16")
    os.close(fd)
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "s16le", tmp],
        capture_output=True,
    )
    if proc.returncode != 0:
        os.unlink(tmp)
        raise RequestError(f"ffmpeg failed to decode {path}: {proc.stderr.decode(errors='replace').strip()[-400:]}")
    n = os.path.getsize(tmp) // 2
    arr = np.memmap(tmp, dtype="<i2", mode="r", shape=(n,)) if n else np.zeros(0, np.int16)
    os.unlink(tmp)  # mapping stays valid after unlink
    return Audio(arr, path)


def quiet_cut(audio: Audio, start: int, max_len: int, search: float = 4.0) -> int:
    """End index for a chunk starting at `start`: the quietest 100 ms frame in the
    last `search` seconds before start+max_len, so we don't cut mid-word."""
    end = start + max_len
    if end >= len(audio.samples):
        return len(audio.samples)
    lo = max(start + 1, end - int(search * SR))
    x = audio.f32(lo, end)
    hop = SR // 10
    frames = len(x) // hop
    if frames < 2:
        return end
    rms = np.sqrt((x[: frames * hop].reshape(frames, hop) ** 2).mean(axis=1))
    return lo + int(np.argmin(rms)) * hop + hop // 2


# ---------------------------------------------------------------------------
# Downloads


def _download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + f".part{os.getpid()}")
    log(f"downloading {url}")
    t0 = time.time()
    req = urllib.request.Request(url, headers={"User-Agent": "butter-rec-asr"})
    with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done, last = 0, 0.0
        while chunk := r.read(1 << 20):
            f.write(chunk)
            done += len(chunk)
            if time.time() - last > 2:
                last = time.time()
                pct = f" ({100 * done / total:.0f}%)" if total else ""
                log(f"  {done / 1e6:.0f} MB{pct}")
    os.replace(tmp, dest)
    log(f"downloaded {dest} ({dest.stat().st_size / 1e6:.1f} MB in {time.time() - t0:.1f}s)")


def ensure_silero_onnx() -> Path:
    path = MODELS_DIR / "vad" / "silero_vad.onnx"
    if not path.exists():
        _download(f"{SHERPA_RELEASE}/silero_vad.onnx", path)
    return path


def ensure_canary(model: str) -> Path:
    p = Path(model).expanduser()
    if p.is_dir():
        return p
    name = CANARY_ALIASES.get(model, model)
    target = MODELS_DIR / name
    if target.is_dir():
        return target
    if "/" in name or not name.startswith("sherpa-onnx-nemo-canary"):
        raise RequestError(f"unknown canary model: {model}")
    archive = MODELS_DIR / f"{name}.tar.bz2"
    _download(f"{SHERPA_RELEASE}/{name}.tar.bz2", archive)
    staging = Path(tempfile.mkdtemp(prefix=".extract-", dir=MODELS_DIR))
    try:
        with tarfile.open(archive, "r:bz2") as tf:
            tf.extractall(staging, filter="data")
        os.replace(staging / name, target)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        archive.unlink(missing_ok=True)
    shutil.rmtree(target / "test_wavs", ignore_errors=True)
    return target


def _find_whisper_file(filename: str) -> Path | None:
    for d in WHISPER_SEARCH_DIRS:
        if (d / filename).is_file():
            return d / filename
    return None


def ensure_whisper_model(model: str) -> Path:
    p = Path(model).expanduser()
    if p.is_file():
        return p
    name = model.removeprefix("ggml-").removesuffix(".bin")
    found = _find_whisper_file(f"ggml-{name}.bin")
    if found:
        return found
    dest = MODELS_DIR / "whisper" / f"ggml-{name}.bin"
    try:
        _download(WHISPER_GGML_URL.format(name=name), dest)
    except Exception as e:
        raise RequestError(f"whisper model {model!r} not found locally and download failed: {e}") from e
    return dest


def ensure_whisper_vad() -> Path | None:
    for d in WHISPER_SEARCH_DIRS:
        for f in sorted(d.glob("ggml-silero-*.bin"), reverse=True) if d.is_dir() else []:
            return f
    try:
        dest = MODELS_DIR / "whisper" / WHISPER_VAD_NAME
        _download(WHISPER_VAD_URL, dest)
        return dest
    except Exception as e:
        log(f"whisper VAD model unavailable ({e}); continuing without --vad")
        return None


def whisper_cli() -> str:
    exe = os.environ.get("BUTTER_WHISPER_CLI") or shutil.which("whisper-cli") or "/opt/homebrew/bin/whisper-cli"
    if not os.path.exists(exe):
        raise RequestError("whisper-cli not found (brew install whisper-cpp, or set BUTTER_WHISPER_CLI)")
    return exe


# ---------------------------------------------------------------------------
# VAD (silero via sherpa-onnx)


def vad_regions(audio: Audio, max_speech: float) -> Generator[Any, None, list[tuple[int, int]]]:
    """Speech regions as (start, end) sample indices. Generator: yields every
    ~30 s of audio so the scheduler can interleave other work."""
    import sherpa_onnx

    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = str(ensure_silero_onnx())
    cfg.silero_vad.threshold = 0.5
    cfg.silero_vad.min_silence_duration = 0.5
    cfg.silero_vad.min_speech_duration = 0.25
    cfg.silero_vad.max_speech_duration = max_speech
    cfg.sample_rate = SR
    cfg.num_threads = 1
    vad = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=max_speech + 30)
    # Must feed exactly window_size samples per call: larger blocks make the
    # detector report late segment starts (clipping the first ~0.7 s of speech).
    win = cfg.silero_vad.window_size
    regions: list[tuple[int, int]] = []

    def drain() -> None:
        while not vad.empty():
            seg = vad.front
            regions.append((seg.start, seg.start + len(seg.samples)))
            vad.pop()

    block = 30 * SR // win * win
    n = len(audio.samples)
    for b in range(0, n, block):
        x = audio.f32(b, min(b + block, n))
        for i in range(0, len(x) - win + 1, win):
            vad.accept_waveform(x[i : i + win])
        drain()
        yield None
    vad.flush()
    drain()
    return regions


def group_regions(regions: list[tuple[int, int]], n: int, merge_gap: float, max_window: float) -> list[tuple[int, int]]:
    """Pad speech regions and merge neighbours into decode windows."""
    pad, gap, maxw = int(VAD_PAD * SR), int(merge_gap * SR), int(max_window * SR)
    windows: list[list[int]] = []
    for s, e in regions:
        s, e = max(0, s - pad), min(n, e + pad)
        if windows and s - windows[-1][1] <= gap and e - windows[-1][0] <= maxw:
            windows[-1][1] = max(windows[-1][1], e)
        else:
            if windows and s < windows[-1][1]:
                s = windows[-1][1]  # padding overlap between split windows
            windows.append([s, e])
    return [(s, e) for s, e in windows if e - s > SR // 10]


# ---------------------------------------------------------------------------
# Engines


@dataclass
class Segment:
    start: float
    end: float
    text: str

    def to_json(self) -> dict[str, Any]:
        return {"start": round(self.start, 3), "end": round(self.end, 3), "text": self.text}


@dataclass
class Result:
    segments: list[Segment]
    model: str
    text: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)


class ParakeetEngine:
    name = "parakeet"

    def __init__(self, model: str):
        import mlx.core as mx
        from parakeet_mlx import from_pretrained

        self.mx = mx
        self.model_id = model
        cache = MODELS_DIR / "huggingface"
        cache.mkdir(parents=True, exist_ok=True)
        self.model = from_pretrained(model, cache_dir=str(cache))

    @staticmethod
    def resolve(model: str | None) -> str:
        model = model or DEFAULT_MODELS["parakeet"]
        return PARAKEET_ALIASES.get(model, model)

    def _decode(self, x: np.ndarray, offset: float) -> list[Any]:
        from parakeet_mlx import DecodingConfig, SentenceConfig
        from parakeet_mlx.audio import get_logmel

        if len(x) < self.model.preprocessor_config.hop_length * 2:
            return []
        mel = get_logmel(self.mx.array(x), self.model.preprocessor_config)
        cfg = DecodingConfig(sentence=SentenceConfig(silence_gap=1.5, max_duration=30.0))
        res = self.model.generate(mel, decoding_config=cfg)[0]
        for sentence in res.sentences:
            for tok in sentence.tokens:
                tok.start += offset
                tok.end = tok.start + tok.duration
        return res.tokens

    def transcribe(self, audio: Audio, windows: list[tuple[int, int]] | None, req: dict) -> Generator[Any, None, Result]:
        from parakeet_mlx import SentenceConfig
        from parakeet_mlx.alignment import (
            merge_longest_common_subsequence,
            merge_longest_contiguous,
            sentences_to_result,
            tokens_to_sentences,
        )

        scfg = SentenceConfig(silence_gap=1.5, max_duration=30.0)
        segments: list[Segment] = []

        def emit(tokens: list[Any]) -> None:
            if tokens:
                for s in sentences_to_result(tokens_to_sentences(tokens, scfg)).sentences:
                    if s.text.strip():
                        segments.append(Segment(s.start, s.end, s.text.strip()))

        try:
            if windows is not None:
                for s, e in windows:
                    emit(self._decode(audio.f32(s, e), s / SR))
                    yield None
            else:
                n = len(audio.samples)
                chunk, overlap = int(PARAKEET_CHUNK * SR), int(PARAKEET_OVERLAP * SR)
                if n <= chunk:
                    emit(self._decode(audio.f32(), 0.0))
                else:
                    tokens: list[Any] = []
                    for s in range(0, n, chunk - overlap):
                        e = min(s + chunk, n)
                        new = self._decode(audio.f32(s, e), s / SR)
                        if tokens and new:
                            try:
                                tokens = merge_longest_contiguous(tokens, new, overlap_duration=PARAKEET_OVERLAP)
                            except RuntimeError:
                                tokens = merge_longest_common_subsequence(tokens, new, overlap_duration=PARAKEET_OVERLAP)
                        elif new:
                            tokens = new
                        yield None
                        if e == n:
                            break
                    emit(tokens)
        finally:
            try:
                self.mx.clear_cache()
            except Exception:
                pass
        return Result(segments, self.model_id)


class CanaryEngine:
    name = "canary"

    def __init__(self, model: str):
        import sherpa_onnx

        self.so = sherpa_onnx
        d = ensure_canary(model)
        enc = next(iter(sorted(d.glob("encoder*.onnx"))), None)
        dec = next(iter(sorted(d.glob("decoder*.onnx"))), None)
        if not enc or not dec or not (d / "tokens.txt").exists():
            raise RequestError(f"incomplete canary model dir: {d}")
        self.model_id = model
        self.recognizer = sherpa_onnx.OfflineRecognizer.from_nemo_canary(
            encoder=str(enc),
            decoder=str(dec),
            tokens=str(d / "tokens.txt"),
            src_lang="en",
            tgt_lang="en",
            num_threads=min(8, os.cpu_count() or 4),
        )
        self.lang = "en"

    @staticmethod
    def resolve(model: str | None) -> str:
        model = model or DEFAULT_MODELS["canary"]
        return CANARY_ALIASES.get(model, model)

    def _set_lang(self, lang: str) -> None:
        if lang == self.lang:
            return
        so = self.so
        self.recognizer.recognizer.set_config(
            config=so.OfflineRecognizerConfig(
                model_config=so.OfflineModelConfig(canary=so.OfflineCanaryModelConfig(src_lang=lang, tgt_lang=lang))
            )
        )
        self.lang = lang

    def transcribe(self, audio: Audio, windows: list[tuple[int, int]] | None, req: dict) -> Generator[Any, None, Result]:
        lang = (req.get("language") or "en").split("-")[0].lower()
        if lang not in CANARY_LANGS:
            raise RequestError(f"canary supports languages {sorted(CANARY_LANGS)}, got {lang!r}")
        self._set_lang(lang)
        if windows is None:
            # No VAD: cut into <= CANARY_MAX_CHUNK pieces at the quietest point near each boundary
            windows, s, n = [], 0, len(audio.samples)
            while s < n:
                e = quiet_cut(audio, s, int(CANARY_MAX_CHUNK * SR))
                windows.append((s, e))
                s = e
        segments: list[Segment] = []
        for s, e in windows:
            if e - s < SR // 10:
                continue
            stream = self.recognizer.create_stream()
            stream.accept_waveform(SR, audio.f32(s, e))
            self.recognizer.decode_stream(stream)
            text = stream.result.text.strip()
            if text:
                segments.append(Segment(s / SR, e / SR, text))
            yield None
        return Result(segments, self.model_id)


class WhisperEngine:
    """Not process-resident: whisper-cli loads the model on every call."""

    name = "whisper"

    def __init__(self, model: str):
        self.model_path = ensure_whisper_model(model)
        self.model_id = model
        self.vad_model = ensure_whisper_vad()
        self.exe = whisper_cli()

    @staticmethod
    def resolve(model: str | None) -> str:
        return model or DEFAULT_MODELS["whisper"]

    def transcribe(self, audio: Audio, use_vad: bool, req: dict, on_proc: Callable[[subprocess.Popen | None], None]) -> Generator[Any, None, Result]:
        tmpdir = tempfile.mkdtemp(prefix="butter-whisper-")
        prefix = os.path.join(tmpdir, "out")
        src = audio.path
        layout = _wav_layout(src)
        if not layout or layout[0] != (1, 1, SR, 16):
            # whisper-cli needs 16 kHz WAV; write the decoded samples out
            src = os.path.join(tmpdir, "in.wav")
            import wave

            with wave.open(src, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(SR)
                pcm = audio.samples if audio.samples.dtype == np.int16 else np.clip(audio.f32() * 32768, -32768, 32767).astype(np.int16)
                w.writeframes(np.ascontiguousarray(pcm).tobytes())
        cmd = [self.exe, "-m", str(self.model_path), "-f", src, "-oj", "-of", prefix, "-np",
               "-t", str(min(8, os.cpu_count() or 4)), "-sns"]
        lang = req.get("language")
        multilingual = not self.model_path.name.endswith(".en.bin")
        if multilingual:
            cmd += ["-l", lang or "auto"]
        if req.get("prompt"):
            cmd += ["--prompt", str(req["prompt"])]
        if use_vad and self.vad_model:
            cmd += ["--vad", "-vm", str(self.vad_model)]
        errf = open(os.path.join(tmpdir, "stderr.txt"), "w+")
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=errf, stderr=errf)
            on_proc(proc)
            while proc.poll() is None:
                yield WAIT
            on_proc(None)
            if proc.returncode != 0:
                errf.seek(0)
                raise RequestError(f"whisper-cli exited {proc.returncode}: {errf.read()[-600:].strip()}")
            with open(prefix + ".json", encoding="utf-8", errors="replace") as f:
                data = json.load(f)
        finally:
            errf.close()
            shutil.rmtree(tmpdir, ignore_errors=True)
        segments = []
        for item in data.get("transcription", []):
            text = item.get("text", "").strip()
            if not text or _is_whisper_noise(text):
                continue
            off = item.get("offsets", {})
            segments.append(Segment(off.get("from", 0) / 1000.0, off.get("to", 0) / 1000.0, text))
        return Result(segments, str(self.model_path))


def _is_whisper_noise(text: str) -> bool:
    t = text.strip()
    return (t[:1] in "[(*" and t[-1:] in "])*") or t in {"[BLANK_AUDIO]", "..."}


ENGINES = {"parakeet": ParakeetEngine, "canary": CanaryEngine, "whisper": WhisperEngine}


# ---------------------------------------------------------------------------
# Worker / scheduler


class Worker:
    def __init__(self, emit: Callable[[dict], None]):
        self.emit = emit
        self.models: dict[tuple[str, str], Any] = {}

    def get_engine(self, engine: str, model: str | None) -> tuple[Any, bool]:
        if engine not in ENGINES:
            raise RequestError(f"unknown engine {engine!r} (expected one of {sorted(ENGINES)})")
        cls = ENGINES[engine]
        resolved = cls.resolve(model)
        key = (engine, resolved)
        if key in self.models:
            return self.models[key], False
        log(f"loading {engine} model {resolved}")
        t0 = time.time()
        inst = cls(resolved)
        log(f"loaded {engine} {resolved} in {time.time() - t0:.2f}s")
        self.models[key] = inst
        return inst, True

    # Each job is a generator; it yields None after a unit of work, WAIT when
    # blocked on a subprocess, and returns the response dict.

    def job_preload(self, req: dict) -> Generator[Any, None, dict]:
        t0 = time.time()
        engine = req.get("engine") or "parakeet"
        inst, loaded = self.get_engine(engine, req.get("model"))
        if engine in ("parakeet", "canary") or req.get("vad"):
            ensure_silero_onnx()
        yield None
        return {"ok": True, "engine": engine, "model": inst.model_id, "loaded": loaded, "elapsed": round(time.time() - t0, 3)}

    def job_unload(self, req: dict) -> Generator[Any, None, dict]:
        engine, model = req.get("engine"), req.get("model")
        drop = [k for k in self.models if (not engine or k[0] == engine) and (not model or k[1] == ENGINES[k[0]].resolve(model))]
        for k in drop:
            del self.models[k]
        import gc

        gc.collect()
        if "mlx.core" in sys.modules:
            sys.modules["mlx.core"].clear_cache()
        yield None
        return {"ok": True, "unloaded": [list(k) for k in drop]}

    def job_transcribe(self, req: dict, job: "Job") -> Generator[Any, None, dict]:
        t0 = time.time()
        engine = req.get("engine") or "parakeet"
        if engine not in ENGINES:
            raise RequestError(f"unknown engine {engine!r} (expected one of {sorted(ENGINES)})")
        path = req.get("audio")
        if not path or not isinstance(path, str):
            raise RequestError("missing 'audio' path")
        audio = load_audio(path)
        job.remaining = audio.duration
        vad_opt = req.get("vad")
        use_vad = audio.duration > AUTO_VAD_MIN_SECONDS if vad_opt is None else bool(vad_opt)

        inst, _ = self.get_engine(engine, req.get("model"))
        yield None

        if engine == "whisper":
            result = yield from inst.transcribe(audio, use_vad, req, job.set_proc)
        else:
            windows = None
            if use_vad and len(audio.samples) > 0:
                p = VAD_PARAMS[engine]
                regions = yield from vad_regions(audio, max_speech=min(20.0, p["max_window"]))
                windows = group_regions(regions, len(audio.samples), p["merge_gap"], p["max_window"])
                log(f"[{job.id}] vad: {len(regions)} speech regions -> {len(windows)} windows, "
                    f"{sum(e - s for s, e in windows) / SR:.1f}s of {audio.duration:.1f}s")
            if len(audio.samples) == 0:
                result = Result([], inst.model_id)
            else:
                result = yield from inst.transcribe(audio, windows, req)

        segs = result.segments
        text = result.text if result.text is not None else " ".join(s.text for s in segs)
        return {
            "ok": True,
            "text": text.strip(),
            "segments": [s.to_json() for s in segs] if req.get("segments", True) else [],
            "duration": round(audio.duration, 3),
            "elapsed": round(time.time() - t0, 3),
            "engine": engine,
            "model": result.model,
        }

    def make_job(self, req: dict) -> "Job":
        job = Job(req)
        cmd = req.get("cmd")
        if cmd == "transcribe":
            job.gen = self.job_transcribe(req, job)
        elif cmd == "preload":
            job.gen = self.job_preload(req)
        elif cmd == "unload":
            job.gen = self.job_unload(req)
        else:
            raise RequestError(f"unknown cmd {cmd!r}")
        return job


@dataclass
class Job:
    req: dict
    gen: Generator[Any, None, dict] | None = None
    remaining: float = 0.0  # audio seconds; lower runs first
    seq: int = 0
    proc: subprocess.Popen | None = None

    @property
    def id(self) -> Any:
        return self.req.get("id")

    def set_proc(self, p: subprocess.Popen | None) -> None:
        self.proc = p

    def kill(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
        if self.gen:
            self.gen.close()


def run_job_sync(worker: Worker, req: dict) -> dict:
    job = worker.make_job(req)
    assert job.gen is not None
    try:
        while True:
            if next(job.gen) is WAIT:
                time.sleep(0.02)
    except StopIteration as stop:
        return stop.value


def serve() -> int:
    # Keep the real stdout for protocol; point fd 1 at stderr so nothing else
    # (native libs, tqdm, stray prints) can write into the protocol stream.
    proto = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    out_lock = threading.Lock()

    def emit(obj: dict) -> None:
        line = json.dumps(obj, ensure_ascii=False)
        with out_lock:
            try:
                proto.write(line + "\n")
                proto.flush()
            except BrokenPipeError:
                os._exit(0)

    emit({"ready": True})
    worker = Worker(emit)
    inbox: queue.Queue = queue.Queue()

    def reader() -> None:
        for raw in sys.stdin:
            raw = raw.strip()
            if not raw:
                continue
            try:
                req = json.loads(raw)
                if not isinstance(req, dict):
                    raise ValueError("request must be a JSON object")
            except Exception as e:
                emit({"id": None, "ok": False, "error": f"bad request: {e}"})
                continue
            if req.get("cmd") == "ping":  # answered immediately, even while busy
                emit({"id": req.get("id"), "ok": True, "pong": True,
                      "loaded": [f"{e}:{m}" for e, m in list(worker.models)]})
                continue
            inbox.put(req)
        inbox.put(None)

    threading.Thread(target=reader, name="stdin-reader", daemon=True).start()

    active: list[Job] = []
    carry: list[dict | None] = []  # request picked up while napping
    seq = 0
    while True:
        # Pull new requests; block only when there is nothing to work on.
        eof = False
        while not eof:
            if carry:
                item = carry.pop()
            else:
                try:
                    item = inbox.get(block=not active)
                except queue.Empty:
                    break
            if item is None:
                eof = True
            elif item.get("cmd") == "cancel":
                target = item.get("target")
                hit = [j for j in active if j.id == target]
                for j in hit:
                    j.kill()
                    active.remove(j)
                    emit({"id": j.id, "ok": False, "error": "cancelled"})
                emit({"id": item.get("id"), "ok": bool(hit), **({} if hit else {"error": f"no active job {target!r}"})})
            else:
                try:
                    job = worker.make_job(item)
                    seq += 1
                    job.seq = seq
                    active.append(job)
                except Exception as e:
                    emit({"id": item.get("id"), "ok": False, "error": str(e)})
        if eof:
            # stdin closed: the parent is gone or shutting down; drop in-flight work
            for j in active:
                j.kill()
            return 0
        if not active:
            continue

        # Shortest remaining audio first (FIFO tie-break). Step one job; if it
        # is blocked on a subprocess, try the next one.
        did_work = False
        for job in sorted(active, key=lambda j: (j.remaining, j.seq)):
            assert job.gen is not None
            try:
                r = next(job.gen)
            except StopIteration as stop:
                active.remove(job)
                emit({"id": job.id, **stop.value})
                did_work = True
                break
            except Exception as e:
                active.remove(job)
                job.kill()
                msg = str(e) if isinstance(e, RequestError) else f"{type(e).__name__}: {e}"
                if not isinstance(e, RequestError):
                    import traceback

                    traceback.print_exc(file=sys.stderr)
                emit({"id": job.id, "ok": False, "error": msg})
                did_work = True
                break
            if r is not WAIT:
                did_work = True
                break
        if not did_work:
            # everyone is waiting on subprocesses; nap until one finishes or a request arrives
            try:
                carry.append(inbox.get(timeout=0.02))
            except queue.Empty:
                pass


def one_shot(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="worker.py transcribe")
    ap.add_argument("audio")
    ap.add_argument("--engine", default="parakeet", choices=sorted(ENGINES))
    ap.add_argument("--model")
    ap.add_argument("--language", default="en")
    ap.add_argument("--prompt")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--vad", dest="vad", action="store_true", default=None, help="force VAD on")
    g.add_argument("--no-vad", dest="vad", action="store_false", help="force VAD off")
    ap.add_argument("--json", action="store_true", help="print the full response JSON")
    a = ap.parse_args(argv)
    req = {"id": "cli", "cmd": "transcribe", "audio": os.path.abspath(a.audio), "engine": a.engine,
           "model": a.model, "language": a.language, "segments": True, "vad": a.vad, "prompt": a.prompt}
    worker = Worker(lambda _: None)
    try:
        resp = {"id": "cli", **run_job_sync(worker, req)}
    except Exception as e:
        resp = {"id": "cli", "ok": False, "error": str(e)}
    if a.json:
        print(json.dumps(resp, ensure_ascii=False, indent=2))
    elif resp["ok"]:
        print(resp["text"])
    else:
        print(f"error: {resp['error']}", file=sys.stderr)
    return 0 if resp["ok"] else 1


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__, file=sys.stderr)
        return 2
    cmd, rest = sys.argv[1], sys.argv[2:]
    if cmd == "serve":
        return serve()
    if cmd == "transcribe":
        return one_shot(rest)
    print(f"unknown mode {cmd!r}; use 'serve' or 'transcribe'", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
