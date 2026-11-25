#!/usr/bin/env python
"""Kokoro TTS 常驻工作进程（由 Electron 主进程通过 stdin/stdout 驱动）。

为什么是常驻：模型有 310MB，冷启动 + 载入 jieba 就要 2–4 秒；
每句都起一次进程的话，回一句话要等五六秒。这里只载入一次。

协议（一行一个 JSON）：
  请求  {"id":1,"text":"...","voice":"zf_xiaoxiao","speed":1.0,
         "model":"...onnx","voices":"...bin","out":"C:/.../x.wav"}
  应答  {"id":1,"ok":true}  或  {"id":1,"ok":false,"error":"..."}

stdin 关闭（父进程退出）时自行结束。
"""
import json
import sys
import wave

import numpy as np


def write_wav(path: str, samples, sample_rate: int) -> None:
    pcm = (np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0) * 32767).astype(np.int16)
    with wave.open(path, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())


def main() -> int:
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    kokoro = None
    g2p = None
    loaded_for = ""

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue

        req_id = req.get("id")
        try:
            text = str(req.get("text") or "").strip()
            if not text:
                raise ValueError("empty-text")

            model_path = str(req.get("model") or "")
            voices_path = str(req.get("voices") or "")
            key = f"{model_path}|{voices_path}"
            if kokoro is None or loaded_for != key:
                from kokoro_onnx import Kokoro
                from misaki import zh as misaki_zh

                kokoro = Kokoro(model_path, voices_path)
                g2p = misaki_zh.ZHG2P()
                loaded_for = key

            result = g2p(text)
            phonemes = result[0] if isinstance(result, tuple) else result
            if not phonemes:
                raise ValueError("g2p-empty")

            speed = req.get("speed")
            try:
                speed_value = float(speed)
            except (TypeError, ValueError):
                speed_value = 1.0

            samples, sample_rate = kokoro.create(
                phonemes,
                voice=str(req.get("voice") or "zf_xiaoxiao"),
                speed=speed_value,
                is_phonemes=True,
            )
            write_wav(str(req.get("out")), samples, sample_rate)
            print(json.dumps({"id": req_id, "ok": True}), flush=True)
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"id": req_id, "ok": False,
                              "error": f"{type(exc).__name__}: {exc}"}), flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
