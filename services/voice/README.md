# AURA Voice Service

## V1 safety boundary

Voice remains a content transformation service for bounded STT/TTS and owns no identity, OAuth, Tool, permission, or approval authority. Realtime speech can request work but cannot approve writes, reconnect/disconnect Google, inject provider credentials, or replay an interrupted side effect. Once a provider mutation is dispatched, cancellation only suppresses stale conversational output and never causes a retry.

The Voice Service is AURA's internal, self-hosted speech transformation boundary. Phase 10 implements a bounded turn-based foundation, not realtime streaming.

## Responsibilities and APIs

- `GET /health`: process liveness.
- `GET /ready`: STT and TTS models were loaded once and are available.

The production image runs as a non-root user and contains the speech runtimes, not model weights. Provision models separately and mount them read-only at `/models`; startup fails and readiness remains unavailable when required weights cannot initialize. Uvicorn handles SIGTERM/SIGINT and the lifespan marks the service unready during shutdown.

- `POST /v1/stt`: authenticated multipart `audio` upload; accepts only 16 kHz, mono, 16-bit PCM WAV up to 10 MiB and 30 seconds.
- `POST /v1/tts`: authenticated JSON `{ "text": "...", "locale": "hi-IN" }`; returns validated mono PCM `audio/wav`. The legacy `language` field remains accepted internally for Phase 10 compatibility.

Gateway is the only normal caller and authenticates with `x-aura-service-id: gateway`, a dedicated `x-aura-service-token`, and `x-request-id`. Voice does not verify users, plan actions, or execute tools. It does not persist audio or log transcript/response content.

## Local models

Run `pnpm voice:model:setup` after creating `services/voice/.venv` and installing `.[dev,speech]`. Model files go under ignored `models/voice`; normal startup never downloads them.

- STT: `Systran/faster-whisper-tiny`, about 78.2 MB, MIT, multilingual (model card lists 99 languages), CTranslate2 CPU `int8`. This is the practical latency-first choice for the i5-7200U/12 GiB machine. English smoke was accurate; the synthetic English-voice Hinglish attempt was not accurate, so Hinglish quality is not claimed.
- TTS: the GPL-3.0-or-later Piper runtime with three official MIT medium ONNX voices, approximately 63.5 MB each: `en_US-lessac-medium`, `hi_IN-pratham-medium`, and `te_IN-padmavathi-medium`. All emit 22.05 kHz mono PCM WAV. Setup verifies the official Hindi/Telugu MD5 digests and startup loads every configured voice once.

Language capability is explicit: English and Hindi are supported; Hinglish is experimental and routes Latin-mixed text to the Hindi voice without transliteration; Telugu is experimental pending broader human listening; Kannada is unsupported because Piper has no official Kannada voice and the evaluated MMS alternative is non-commercial and requires another runtime. Unsupported Kannada requests return `VOICE_TTS_UNAVAILABLE` rather than misleading output.

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

There is no WebSocket/WebRTC transport, partial transcript, VAD boundary, barge-in, wake word, retry, frontend, continuous conversation, or automatic transliteration. The public response uses bounded base64 WAV in JSON. CPU LLM latency still dominates complete voice turns.

## Grounded knowledge answers

An explicit saved-knowledge question uses the same generic STT → Gateway orchestration → Agent continuation → TTS path. Gateway owns retrieval and citation validation; Voice receives and synthesizes final response text only. It never receives vectors, similarity, embedding model, permissions, evidence chunks, or citation database metadata, and it has no direct knowledge-search authority. Phase 35 does not persist transcripts or enable automatic RAG for ordinary speech.

## Explicit memory requests

Voice uses the generic authenticated Agent/Gateway path for a finalized explicit request such as “remember that I prefer morning meetings.” Voice Service has no database or memory authority, stores no transcripts, and cannot infer or extract memories from background speech. A stale or interrupted turn cannot start a second mutation; after a memory mutation crosses the dispatch boundary it is not aborted or retried, and stale completion output is suppressed using the existing interruption semantics.
