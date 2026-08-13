# AURA Voice Service

The Voice Service is AURA's internal, self-hosted speech transformation boundary. Phase 10 implements a bounded turn-based foundation, not realtime streaming.

## Responsibilities and APIs

- `GET /health`: process liveness.
- `GET /ready`: STT and TTS models were loaded once and are available.
- `POST /v1/stt`: authenticated multipart `audio` upload; accepts only 16 kHz, mono, 16-bit PCM WAV up to 10 MiB and 30 seconds.
- `POST /v1/tts`: authenticated JSON `{ "text": "...", "language": "en" }`; returns `audio/wav`.

Gateway is the only normal caller and authenticates with `x-aura-service-id: gateway`, a dedicated `x-aura-service-token`, and `x-request-id`. Voice does not verify users, plan actions, or execute tools. It does not persist audio or log transcript/response content.

## Local models

Run `pnpm voice:model:setup` after creating `services/voice/.venv` and installing `.[dev,speech]`. Model files go under ignored `models/voice`; normal startup never downloads them.

- STT: `Systran/faster-whisper-tiny`, about 78.2 MB, MIT, multilingual (model card lists 99 languages), CTranslate2 CPU `int8`. This is the practical latency-first choice for the i5-7200U/12 GiB machine. English smoke was accurate; the synthetic English-voice Hinglish attempt was not accurate, so Hinglish quality is not claimed.
- TTS: Piper `en_US-lessac-medium`, about 63.3 MB, MIT voice weights, 22.05 kHz mono output. The installed Piper runtime is GPL-3.0-or-later. This voice supports English only; Hindi, Hinglish, Telugu, and Kannada synthesis fail explicitly instead of using misleading English phonetics.

Configuration is documented in `.env.example`. Start from the repository root after setting the service token:

```powershell
$env:AURA_INTERNAL_SERVICE_TOKEN = "replace-with-at-least-32-characters"
pnpm voice:model:setup
.\services\voice\.venv\Scripts\python.exe -m aura_voice.main
```

Run deterministic checks with `pnpm voice:lint`, `voice:typecheck`, `voice:test`, and `voice:build`. Run real local inference separately with:

```powershell
.\services\voice\.venv\Scripts\python.exe services/voice/scripts/smoke_models.py
```

## Limitations

There is no WebSocket/WebRTC transport, partial transcript, VAD boundary, barge-in, wake word, retry, frontend, or continuous conversation. The public Phase 10 response uses bounded base64 WAV in JSON; streaming should replace it in a later milestone. CPU LLM latency still dominates complete voice turns.
