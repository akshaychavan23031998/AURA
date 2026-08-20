# AURA Web

Contacts consent and provider tokens remain server-side. The browser receives only ordinary AURA session/tool responses and uses the standard reconnect state when Contacts re-consent is required.

The authenticated Connected Google Account panel shows human-readable Calendar, Gmail, and Contacts capabilities as Connected or Needs permission. It fetches only sanitized status and starts re-consent only after an explicit click. Provider tokens and raw scopes never enter JavaScript, Redux, localStorage, or sessionStorage. Local disconnect leaves the AURA session authenticated.

`PROVIDER_REAUTH_REQUIRED` produces a safe reconnect instruction. The UI does not redirect automatically and never replays the failed Tool request, an approved write, or microphone audio after consent. OAuth and disconnect are browser-only controls; spoken commands have no provider-consent authority.

Phase 20 integrates an accessible approval card into the live protocol-driven voice experience. `approval.required` supplies only the approval ID, safe title/preview, and expiry; deliberate Approve or Reject activation calls the fixed authenticated Gateway route. Loading, rejection, completion, expiry, session failure, and sanitized error states are represented. Transcript text—including “yes” or “approve”—never invokes the approval API, and the UI never resubmits tool arguments or trusted policy metadata.

When Calendar access is enabled, Google consent includes the official Calendar read and event-write scopes plus offline token issuance. The browser still receives only AURA session credentials; Google tokens never enter frontend JavaScript, Redux, storage, URLs, or voice events. Calendar create, update, and delete use the existing accessible `ApprovalCard`: merely rendering or reading an approval cannot execute, and voice phrases have no approval authority. Only an explicit authenticated Approve click can resume the exact persisted action; the browser never resubmits event data or policy metadata.

When `GOOGLE_GMAIL_ENABLED` is configured, Google consent requests only `gmail.readonly` and narrow `gmail.send`. Gmail credentials remain server-side. Send/reply proposals render through the existing generic ApprovalCard; the browser submits only the approval decision and never recipient, body, MIME, provider token, or proof. Existing users missing either required scope receive a safe reconnect requirement.

The Phase 16 web application provides Google account entry, browser session bootstrap, and the authenticated `aura.voice.v1` experience without owning identity, orchestration, or authorization decisions.

## Authentication and session lifecycle

On initial load the application remains in `bootstrapping` while it calls the Gateway refresh endpoint with credentials enabled. Gateway rotates the opaque refresh token in an HttpOnly cookie and returns only a short-lived access JWT. The JWT lives in a module-private in-memory store, not Redux, localStorage, or sessionStorage. Concurrent refresh requests share one promise.

The native authenticated-fetch wrapper attaches the latest JWT and may refresh and retry a safe `GET`, `HEAD`, or `OPTIONS` request once. It never automatically retries POST actions. A new voice WebSocket reads the latest in-memory token; an open socket is never mutated or silently reconnected. Logout revokes the persisted session, clears memory, and unmounts voice capture and playback.

Production account entry is an ordinary navigation to the Gateway's fixed `/api/v1/auth/google/start` endpoint. OAuth codes and provider tokens never enter frontend JavaScript or URLs controlled by the frontend. After Gateway finishes the callback and returns to the trusted web origin, the existing refresh bootstrap obtains a new memory-only AURA access JWT.

A local bootstrap button remains separate and is built only when both `NODE_ENV=development` and `NEXT_PUBLIC_ENABLE_DEV_SESSION=true`; Gateway independently requires its development runtime and always chooses the fixed server-side development identity. The browser cannot select users or permissions.

Browser WebSocket APIs cannot set `Authorization`. The client therefore offers `aura.voice.v1` plus `aura.jwt.<access-token>` as WebSocket subprotocols. Gateway selects only `aura.voice.v1`, invokes its existing JWT/session verifier, and redacts the credential-bearing header. Use HTTPS/WSS in production.

## Voice pipeline

`getUserMedia` captures one microphone track. A minimal AudioWorklet copies mono float samples to the main thread, where bounded helpers resample them to 16 kHz, encode signed PCM16 little-endian, and emit exact 20 ms/640-byte frames. Tracks, nodes, pending samples, sockets, object URLs, and playback are released on disconnect or unmount. Microphone bytes are never stored in Redux, browser storage, logs, or analytics.

Gateway events are runtime validated as untrusted input. Redux stores only frontend-safe state, turn identifiers, transcript text, and errors. Binary WAV chunks are held in order for the current turn and discarded when the authoritative Gateway interrupts or supersedes it.

## Configuration

```env
NEXT_PUBLIC_GATEWAY_URL=https://gateway.example.com
NEXT_PUBLIC_GOOGLE_OIDC_ENABLED=true
# Development builds only:
NEXT_PUBLIC_ENABLE_DEV_SESSION=true
```

Deploy the web app and Gateway on the same schemeful site when using `SameSite=Strict`, configure Gateway `WEB_APP_ORIGIN` to the exact web origin, and use HTTPS/WSS. Users cannot provide arbitrary Gateway URLs through the interface.

The production image uses Next.js standalone output and bakes `NEXT_PUBLIC_*` settings at image build time. The production-like stack uses one public origin for Web and Gateway, so `NEXT_PUBLIC_GATEWAY_URL` is that exact HTTPS origin. Do not reuse an image across origins unless it was built for that origin. Microphone capture requires a browser-trusted secure context; Caddy's localhost certificate must be trusted for local validation.

## Commands

```bash
pnpm --filter @aura/web dev
pnpm --filter @aura/web test
pnpm --filter @aura/web lint
pnpm --filter @aura/web typecheck
pnpm --filter @aura/web build
```
