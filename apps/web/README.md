# AURA Web

The Phase 14 web application is the browser client for authenticated `aura.voice.v1` sessions. It provides an accessible, responsive, in-memory conversation experience without owning orchestration or authorization decisions.

## Voice pipeline

`getUserMedia` captures one microphone track. A minimal AudioWorklet copies mono float samples to the main thread, where bounded helpers resample them to 16 kHz, encode signed PCM16 little-endian, and emit exact 20 ms/640-byte frames. Frames are sent only while the authenticated WebSocket is open. Tracks, nodes, pending samples, sockets, object URLs, and playback are released on disconnect or unmount. Microphone bytes are never stored in Redux, browser storage, logs, or analytics.

Gateway control events are runtime validated as untrusted input. Redux stores only frontend-safe status, current turn identifiers, transcript text, and errors. WebSocket, media, and audio objects remain in the session client. Binary WAV chunks are held in order for the current turn only, played after `audio.completed`, and discarded immediately when the authoritative Gateway emits an interruption or supersession event.

## Authentication

Browser WebSocket APIs cannot set `Authorization`. The client therefore offers `aura.voice.v1` plus `aura.jwt.<access-token>` as WebSocket subprotocols. Gateway selects only `aura.voice.v1`, extracts the bounded credential before invoking its existing JWT/session verifier, and redacts the complete subprotocol header. Use `wss:` in deployed environments.

The frontend reads an existing access JWT from session storage key `aura.accessToken`; it does not contain a login bypass or hard-coded credential. Phase 14 does not implement login/account UI. The existing identity flow—or a future production login flow—must establish the access token. Refresh tokens and session secrets must not be stored by this voice client.

Configure a fixed deployment Gateway origin at build time when it differs from the web origin:

```env
NEXT_PUBLIC_GATEWAY_URL=https://gateway.example.com
```

Users cannot supply arbitrary connection URLs through the interface. Connection failures never replay captured utterances and reconnection is manual.

## Commands

```bash
pnpm --filter @aura/web dev
pnpm --filter @aura/web test
pnpm --filter @aura/web lint
pnpm --filter @aura/web typecheck
pnpm --filter @aura/web build
```
