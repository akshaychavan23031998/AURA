def test_health_and_ready(client):
    assert client.get("/health").json() == {"status": "ok", "service": "voice"}
    assert client.get("/ready").status_code == 200


def test_stt_validates_and_correlates(client, headers, wav_bytes_fixture):
    response = client.post(
        "/v1/stt",
        headers=headers,
        files={"audio": ("audio.wav", wav_bytes_fixture, "audio/wav")},
    )
    assert response.status_code == 200
    assert response.headers["x-request-id"] == "voice-test-1"
    assert response.json()["text"] == "echo AURA"


def test_rejects_invalid_audio(client, headers):
    response = client.post(
        "/v1/stt", headers=headers, files={"audio": ("bad.wav", b"bad", "audio/wav")}
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "VOICE_INVALID_AUDIO"


def test_internal_auth_required(client, wav_bytes_fixture):
    assert (
        client.post(
            "/v1/stt", files={"audio": ("audio.wav", wav_bytes_fixture, "audio/wav")}
        ).status_code
        == 401
    )


def test_tts_returns_wav(client, headers):
    response = client.post(
        "/v1/tts", headers=headers, json={"text": "hello", "language": "en"}
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.content.startswith(b"RIFF")


def test_tts_accepts_locale_and_rejects_unknown_locale(client, headers):
    assert (
        client.post(
            "/v1/tts", headers=headers, json={"text": "नमस्ते", "locale": "hi-IN"}
        ).status_code
        == 200
    )
    response = client.post(
        "/v1/tts", headers=headers, json={"text": "bonjour", "locale": "fr"}
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VOICE_LANGUAGE_UNSUPPORTED"
