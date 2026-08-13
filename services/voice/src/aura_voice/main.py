import uvicorn

from aura_voice.config import get_settings


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "aura_voice.app:create_runtime_app",
        factory=True,
        host=settings.voice_host,
        port=settings.voice_port,
        log_config=None,
    )


if __name__ == "__main__":
    main()
