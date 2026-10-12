#!/usr/bin/env python3
"""Transcreve áudio com faster-whisper. Uso: transcribe.py <audio> [--model turbo]
Saída: JSON {segments:[{start,end,text}], text, language} no stdout.
Modelos: tiny, base, small, medium, large-v3, large-v3-turbo ("turbo").
CUDA só se o torch confirmar; senão CPU int8.
"""
import json
import sys

try:
    from faster_whisper import WhisperModel
except ImportError:
    print(json.dumps({"error": "faster-whisper não instalado (pip install faster-whisper)"}))
    sys.exit(2)


def load_model(name):
    use_cuda = False
    try:
        import torch
        use_cuda = torch.cuda.is_available()
    except Exception:
        pass
    if use_cuda:
        try:
            return WhisperModel(name, device="cuda", compute_type="float16")
        except Exception:
            pass
    return WhisperModel(name, device="cpu", compute_type="int8")


def main():
    if len(sys.argv) < 2 or sys.argv[1] == "--help":
        print(json.dumps({"ok": True, "usage": "transcribe.py <audio> [--model turbo]"}))
        sys.exit(0)
    audio = sys.argv[1]
    model_name = "turbo"
    if "--model" in sys.argv:
        model_name = sys.argv[sys.argv.index("--model") + 1]
    if model_name == "turbo":
        model_name = "large-v3-turbo"

    model = load_model(model_name)
    segments, info = model.transcribe(audio, language="pt", beam_size=5)
    out_segments = []
    texts = []
    for s in segments:
        t = s.text.strip()
        out_segments.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": t})
        texts.append(t)
    print(json.dumps({
        "segments": out_segments,
        "text": " ".join(texts),
        "language": info.language,
        "duration": round(info.duration, 2),
        "model": model_name,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
