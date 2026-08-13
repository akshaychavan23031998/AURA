import asyncio
import io
import json
import time
import wave
from pathlib import Path

from aura_voice.audio import ValidatedAudio
from aura_voice.speech import LocalSpeechTranscriber, LocalTtsSynthesizer


async def main() -> None:
    semaphore = asyncio.Semaphore(1)
    transcriber = LocalSpeechTranscriber(
        "models/voice/faster-whisper-tiny", "cpu", "int8", semaphore
    )
    synthesizer = LocalTtsSynthesizer(
        Path("models/voice/en_US-lessac-medium.onnx"), semaphore
    )
    started = time.perf_counter()
    await transcriber.initialize()
    await synthesizer.initialize()
    results: list[dict[str, object]] = []
    for label, text in (
        ("english", "hello AURA"),
        ("hinglish-attempt", "bhai AURA ko echo kar de"),
    ):
        tts_started = time.perf_counter()
        wav_bytes = await synthesizer.synthesize(text, "en")
        tts_ms = (time.perf_counter() - tts_started) * 1000
        with wave.open(io.BytesIO(wav_bytes), "rb") as wav_file:
            duration_ms = wav_file.getnframes() / wav_file.getframerate() * 1000
        audio = ValidatedAudio(wav_bytes, duration_ms, 22050)
        stt_started = time.perf_counter()
        transcription = await transcriber.transcribe(audio, None)
        results.append(
            {
                "case": label,
                "sourceText": text,
                "transcript": transcription.text,
                "detectedLanguage": transcription.detected_language,
                "audioBytes": len(wav_bytes),
                "audioDurationMs": round(duration_ms, 3),
                "ttsDurationMs": round(tts_ms, 3),
                "sttDurationMs": round((time.perf_counter() - stt_started) * 1000, 3),
            }
        )
    print(
        json.dumps(
            {
                "loadAndTotalMs": round((time.perf_counter() - started) * 1000, 3),
                "results": results,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
