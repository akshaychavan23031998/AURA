import asyncio
import io
import json
import time
import wave
from pathlib import Path

from aura_voice.audio import ValidatedAudio
from aura_voice.locale import normalize_locale
from aura_voice.speech import LocalSpeechTranscriber
from aura_voice.tts import PiperEngine, VoiceCapability, VoiceRegistry

CASES = (
    ("English", "Hello from AURA", "en-IN"),
    ("Hindi", "नमस्ते, मैं ऑरा हूँ", "hi-IN"),
    ("Hinglish", "Namaste, main AURA hoon", "hi-IN"),
    ("Telugu", "నమస్కారం, నేను ఆరా", "te-IN"),
)


async def main() -> None:
    semaphore = asyncio.Semaphore(1)
    root = Path("models/voice")
    engines = {
        "en": PiperEngine(root / "en_US-lessac-medium.onnx", semaphore),
        "hi": PiperEngine(root / "hi_IN-pratham-medium.onnx", semaphore),
        "te": PiperEngine(root / "te_IN-padmavathi-medium.onnx", semaphore),
    }
    registry = VoiceRegistry(
        engines,
        tuple(
            VoiceCapability(language, (), None, 22050, "smoke")
            for language in ("en", "hi", "te")
        ),
        30,
        12 * 1024 * 1024,
    )
    transcriber = LocalSpeechTranscriber(
        "models/voice/faster-whisper-tiny", "cpu", "int8", semaphore
    )
    initialized = time.perf_counter()
    await registry.initialize()
    await transcriber.initialize()
    cold_ms = (time.perf_counter() - initialized) * 1000
    results = []
    for language, text, locale in CASES:
        started = time.perf_counter()
        audio = await registry.synthesize(text, normalize_locale(locale, text))
        tts_ms = (time.perf_counter() - started) * 1000
        with wave.open(io.BytesIO(audio), "rb") as wav:
            rate = wav.getframerate()
            duration_ms = wav.getnframes() / rate * 1000
        stt_started = time.perf_counter()
        transcript = await transcriber.transcribe(
            ValidatedAudio(audio, duration_ms, rate), None
        )
        results.append(
            {
                "language": language,
                "locale": locale,
                "transcript": transcript.text,
                "ttsMs": round(tts_ms, 3),
                "sttMs": round((time.perf_counter() - stt_started) * 1000, 3),
                "durationMs": round(duration_ms, 3),
                "sampleRate": rate,
                "bytes": len(audio),
                "rtf": round(tts_ms / duration_ms, 3),
            }
        )
    print(
        json.dumps(
            {"coldInitializationMs": round(cold_ms, 3), "results": results},
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
