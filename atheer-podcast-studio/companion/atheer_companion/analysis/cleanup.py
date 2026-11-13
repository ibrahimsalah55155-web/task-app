"""Voice clean-up for podcast microphones (FFmpeg, runs locally).

Each microphone file is processed into a new WAV with exactly the same sample
rate, channel count, length and timing as the original, so the panel can swap
the media under the clips without moving anything on the timeline. The
original file is never modified; the panel can switch back at any time.

Chain (each step optional):
  high-pass (rumble)  ->  RNNoise denoise (voice model, keeps laughter)
  ->  hum notch (50/60 Hz + harmonics)  ->  de-esser  ->  presence EQ
  ->  compressor  ->  loudness: measure (EBU R128), apply the exact gain, peak-limit
      (look-ahead with latency compensation), measure the result, correct once if needed
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any, Callable

import numpy as np

MODEL_DIR = Path(__file__).with_name("models")
RNN_MODEL = "rnnoise_voice.rnnn"

PRESETS: dict[str, dict[str, Any]] = {
    "light": {"highpass": 70, "denoise": 0.6, "hum": False, "deess": 0.25, "presence": 1.0,
              "compress": 2.0, "lufs": -16.0},
    "standard": {"highpass": 80, "denoise": 0.85, "hum": True, "deess": 0.4, "presence": 2.0,
                 "compress": 3.0, "lufs": -16.0},
    "strong": {"highpass": 100, "denoise": 1.0, "hum": True, "deess": 0.55, "presence": 3.0,
               "compress": 4.0, "lufs": -16.0},
}
# -16 LUFS: podcast/YouTube; -14 LUFS: Instagram/TikTok reels.
LOUDNESS_TARGETS = {"podcast": -16.0, "social": -14.0, "broadcast": -23.0}


class CleanupError(RuntimeError):
    pass


def settings(preset: str = "standard", overrides: dict[str, Any] | None = None) -> dict[str, Any]:
    if preset not in PRESETS:
        raise CleanupError(f"unknown preset {preset}")
    s = dict(PRESETS[preset])
    for k, v in (overrides or {}).items():
        if k in s and v is not None:
            s[k] = v
    return s


def _probe(ffprobe: str, path: str) -> dict[str, Any]:
    out = subprocess.run([ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries",
                          "stream=sample_rate,channels:format=duration", "-of", "json", path],
                         capture_output=True, text=True, check=False)
    try:
        d = json.loads(out.stdout or "{}")
        st = d["streams"][0]
        return {"sr": int(st["sample_rate"]), "ch": int(st["channels"]), "dur": float(d["format"]["duration"])}
    except Exception as e:  # noqa: BLE001
        raise CleanupError(f"No audio stream in {path}") from e


def _chain(s: dict[str, Any], sr: int, hum_hz: int) -> list[str]:
    f: list[str] = []
    if s.get("highpass"):
        f.append(f"highpass=f={int(s['highpass'])}:p=2")
    if s.get("denoise"):
        # RNNoise works on 48 kHz, 480-sample frames and outputs one frame late:
        # drop that frame so the result stays sample-aligned with the original.
        f += ["aresample=48000", f"arnndn=m={RNN_MODEL}:mix={float(s['denoise']):.2f}",
              "atrim=start_sample=480", "asetpts=PTS-STARTPTS", f"aresample={sr}"]
    if s.get("hum"):
        for k in (1, 2, 3):
            if hum_hz * k < sr / 2:
                f.append(f"bandreject=f={hum_hz * k}:width_type=q:w=30")
    if s.get("deess"):
        f.append(f"deesser=i={float(s['deess']):.2f}:m=0.5:f=0.5")
    if s.get("presence"):
        g = float(s["presence"])
        f += [f"equalizer=f=250:t=q:w=1.0:g={-g / 2:.1f}", f"equalizer=f=3500:t=q:w=0.9:g={g:.1f}"]
    if s.get("compress"):
        f.append(f"acompressor=threshold=-21dB:ratio={float(s['compress']):.1f}:attack=8:release=160:makeup=1")
    return f


def _hum_frequency(ffmpeg: str, path: str, dur: float) -> int:
    """50 Hz (Egypt/Europe mains) or 60 Hz, from the strongest of the two in a short sample."""
    start = max(0.0, min(dur / 2, dur - 20))
    p = subprocess.run([ffmpeg, "-v", "error", "-ss", f"{start:.2f}", "-t", "20", "-i", path, "-ac", "1", "-ar", "8000",
                        "-f", "s16le", "-"], capture_output=True, check=False)
    x = np.frombuffer(p.stdout, np.int16).astype(np.float32)
    if x.size < 8000:
        return 50
    spec = np.abs(np.fft.rfft(x * np.hanning(x.size)))
    freqs = np.fft.rfftfreq(x.size, 1 / 8000)

    def band(f0: float) -> float:
        m = (freqs > f0 - 1.5) & (freqs < f0 + 1.5)
        return float(spec[m].max()) if m.any() else 0.0

    return 60 if band(60) + band(120) > 1.2 * (band(50) + band(100)) else 50


def _run(cmd: list[str], cwd: Path, cancel: threading.Event | None, on_time: Callable[[float], None] | None) -> str:
    proc = subprocess.Popen(cmd, cwd=str(cwd), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
                            encoding="utf-8", errors="replace",
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    err: list[str] = []
    assert proc.stderr is not None
    for line in proc.stderr:
        err.append(line)
        if cancel is not None and cancel.is_set():
            proc.kill()
            raise CleanupError("cancelled")
        if on_time:
            m = re.search(r"time=(\d+):(\d+):([\d.]+)", line)
            if m:
                on_time(int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)))
    proc.wait()
    text = "".join(err)
    if proc.returncode != 0:
        raise CleanupError(text.strip().splitlines()[-1] if text.strip() else "ffmpeg failed")
    return text


def _loudness_json(text: str) -> dict[str, str]:
    m = re.search(r"\{\s*\"input_i\"[^{}]*\}", text, re.S)
    if not m:
        raise CleanupError("loudness measurement failed")
    return json.loads(m.group(0))


def clean_file(ffmpeg: str, ffprobe: str, src: str, dst: str, s: dict[str, Any],
               progress: Callable[[float, str], None] | None = None,
               cancel: threading.Event | None = None) -> dict[str, Any]:
    prog = progress or (lambda f, m: None)
    if not Path(src).is_file():
        raise CleanupError(f"File not found or drive disconnected: {src}")
    info = _probe(ffprobe, src)
    sr, ch, dur = info["sr"], info["ch"], info["dur"]
    hum = _hum_frequency(ffmpeg, src, dur) if s.get("hum") else 50
    chain = _chain(s, sr, hum)
    work = Path(dst).parent
    work.mkdir(parents=True, exist_ok=True)
    # The RNNoise model is referenced by a relative name (Windows drive colons break filter syntax).
    if s.get("denoise"):
        shutil.copyfile(MODEL_DIR / RNN_MODEL, work / RNN_MODEL)
    lufs = float(s.get("lufs", -16.0))
    tp = -1.5 if lufs > -20 else -2.0
    base = [ffmpeg, "-hide_banner", "-nostdin", "-y", "-i", src, "-map", "0:a:0"]

    prog(0.0, "Measuring loudness")
    first = ",".join(chain + [f"loudnorm=I={lufs}:TP={tp}:LRA=11:print_format=json"])
    m = _loudness_json(_run(base + ["-af", first, "-f", "null", "-"], work, cancel,
                            lambda t: prog(0.3 * min(1.0, t / max(dur, 1e-6)), "Measuring loudness")))
    gain = lufs - float(m["input_i"])
    limit = 10 ** ((tp - 0.5) / 20)  # sample-peak ceiling a little under the true-peak target
    n_samples = int(round(dur * sr))
    tmp = Path(dst).with_suffix(".part.wav")
    after: dict[str, str] = {}
    tried: list[tuple[float, float]] = []  # (gain, resulting loudness)
    for attempt in range(4):
        second = ",".join(chain + [
            f"volume={gain:.3f}dB",
            f"alimiter=limit={limit:.4f}:attack=2:release=50:level=disabled:latency=1",
            f"aresample={sr}", f"apad=whole_len={n_samples}", f"atrim=end_sample={n_samples}",
        ])
        _run(base + ["-af", second, "-ar", str(sr), "-ac", str(ch), "-c:a", "pcm_s24le", "-rf64", "auto",
                     "-f", "wav", str(tmp)], work, cancel,
             lambda t: prog(0.3 + 0.55 * min(1.0, t / max(dur, 1e-6)), "Cleaning"))
        after = _loudness_json(_run([ffmpeg, "-hide_banner", "-nostdin", "-i", str(tmp), "-af",
                                     f"loudnorm=I={lufs}:TP={tp}:print_format=json", "-f", "null", "-"],
                                    work, cancel, None))
        got = float(after["input_i"])
        tried.append((gain, got))
        if abs(lufs - got) <= 0.3:
            break
        # The limiter ate some loudness: step again, using the measured slope when we have two points.
        if len(tried) >= 2 and tried[-1][1] != tried[-2][1]:
            slope = (tried[-1][1] - tried[-2][1]) / (tried[-1][0] - tried[-2][0])
            gain += (lufs - got) / max(0.2, min(1.0, slope))
        else:
            gain += lufs - got
        gain = min(gain, lufs - float(m["input_i"]) + 12)  # never more than 12 dB of limiting
    os.replace(tmp, dst)
    out = _probe(ffprobe, dst)
    prog(0.97, "Checking timing")
    lag = measure_lag(ffmpeg, src, dst, dur)
    if abs(lag) > 0.002:
        raise CleanupError(f"cleaned audio is shifted by {lag * 1000:.1f} ms; not using it")
    if abs(out["dur"] - dur) > 1.0 / sr * 2 or out["sr"] != sr or out["ch"] != ch:
        raise CleanupError("cleaned file does not match the original length/format")
    return {"source": src, "output": dst, "sampleRate": sr, "channels": ch, "duration": dur, "humHz": hum,
            "lufsBefore": float(m["input_i"]), "lufsAfter": float(after["input_i"]),
            "truePeakAfter": float(after["input_tp"]), "gainDb": round(tried[-1][0], 2), "lagMs": round(float(lag) * 1000, 3), "settings": s}


def measure_lag(ffmpeg: str, a: str, b: str, dur: float) -> float:
    """Seconds by which b is late relative to a (cross-correlation on a 30 s window at 16 kHz)."""
    start = max(0.0, min(dur / 3, dur - 30))
    span = min(30.0, dur)

    def read(p: str) -> np.ndarray:
        r = subprocess.run([ffmpeg, "-v", "error", "-ss", f"{start:.3f}", "-t", f"{span:.3f}", "-i", p, "-ac", "1",
                            "-ar", "16000", "-f", "s16le", "-"], capture_output=True, check=False)
        return np.frombuffer(r.stdout, np.int16).astype(np.float32)

    x, y = read(a), read(b)
    n = min(x.size, y.size)
    if n < 1600:
        return 0.0
    x, y = x[:n] - x[:n].mean(), y[:n] - y[:n].mean()
    # GCC-PHAT: whitened cross-spectrum. Gives one sharp peak at the true delay even for very
    # periodic voiced speech and after heavy EQ/compression (plain correlation can lock onto a pitch period).
    size = 1 << int(np.ceil(np.log2(2 * n)))
    cross = np.fft.rfft(y, size) * np.conj(np.fft.rfft(x, size))
    cross /= np.abs(cross) + 1e-9
    up = 8  # 2 kHz -> 1/128 ms resolution
    c = np.fft.irfft(cross, size * up)
    max_lag = 1600 * up  # ±100 ms
    c = np.concatenate([c[-max_lag:], c[: max_lag + 1]])
    k = int(np.argmax(c))
    return (k - max_lag) / (16000.0 * up)


def output_path(out_dir: str, src: str, preset: str) -> str:
    stem = Path(src).stem
    return str(Path(out_dir) / f"{stem}_MAG_clean_{preset}.wav")
