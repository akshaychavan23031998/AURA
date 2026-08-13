import uvicorn

from aura_agent.config import get_settings


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "aura_agent.app:create_runtime_app",
        factory=True,
        host=settings.agent_host,
        port=settings.agent_port,
        log_config=None,
    )


if __name__ == "__main__":
    main()
