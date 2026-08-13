import hmac
import logging
import re
import time
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Annotated
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from aura_agent.config import Settings, get_settings
from aura_agent.contracts import AgentRequest, AgentResponse
from aura_agent.logging import configure_logging
from aura_agent.planner import (
    AgentPlanningError,
    AgentService,
    DeterministicDevelopmentPlanner,
    Planner,
)

REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
logger = logging.getLogger("aura.agent")


def create_app(settings: Settings, planner: Planner | None = None) -> FastAPI:
    configure_logging(settings.log_level)
    service = AgentService(planner or DeterministicDevelopmentPlanner())

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        logger.info("Agent Service initialized")
        yield
        logger.info("Agent Service stopped")

    app = FastAPI(
        title="AURA Agent Service", docs_url=None, redoc_url=None, lifespan=lifespan
    )
    app.state.ready = True

    @app.middleware("http")
    async def request_context(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        supplied = request.headers.get("x-request-id", "")
        request_id = (
            supplied if REQUEST_ID_PATTERN.fullmatch(supplied) else str(uuid4())
        )
        request.state.request_id = request_id
        started = time.perf_counter()
        if (
            request.headers.get("content-length", "0").isdigit()
            and int(request.headers.get("content-length", "0"))
            > settings.request_body_limit
        ):
            response = error_response(
                413, "PAYLOAD_TOO_LARGE", "Request payload is too large", request_id
            )
        else:
            response = await call_next(request)
        response.headers["x-request-id"] = request_id
        logger.info(
            "HTTP request completed",
            extra={
                "requestId": request_id,
                "method": request.method,
                "path": request.url.path,
                "statusCode": response.status_code,
                "durationMs": round((time.perf_counter() - started) * 1000, 3),
            },
        )
        return response

    async def authenticate(
        service_id: Annotated[str | None, Header(alias="x-aura-service-id")] = None,
        token: Annotated[str | None, Header(alias="x-aura-service-token")] = None,
    ) -> None:
        valid_id = service_id is not None and hmac.compare_digest(
            service_id, settings.aura_allowed_service_id
        )
        valid_token = token is not None and hmac.compare_digest(
            token, settings.aura_internal_service_token
        )
        if not (valid_id and valid_token):
            raise InternalAuthenticationError

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "agent"}

    @app.get("/ready")
    async def ready() -> dict[str, str]:
        return {"status": "ready", "service": "agent"}

    @app.post(
        "/v1/agent/respond",
        response_model=AgentResponse,
        dependencies=[Depends(authenticate)],
    )
    async def respond(payload: AgentRequest, request: Request) -> AgentResponse:
        result = await service.respond(payload)
        return AgentResponse(**result.model_dump(), requestId=request.state.request_id)

    register_error_handlers(app)
    return app


class InternalAuthenticationError(Exception):
    pass


def request_id(request: Request) -> str:
    return getattr(request.state, "request_id", str(uuid4()))


def error_response(
    http_status: int, code: str, message: str, correlation_id: str
) -> JSONResponse:
    return JSONResponse(
        status_code=http_status,
        content={
            "error": {"code": code, "message": message, "requestId": correlation_id}
        },
    )


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(InternalAuthenticationError)
    async def authentication_error(
        request: Request, _: InternalAuthenticationError
    ) -> JSONResponse:
        return error_response(401, "UNAUTHORIZED", "Unauthorized", request_id(request))

    @app.exception_handler(RequestValidationError)
    async def validation_error(
        request: Request, _: RequestValidationError
    ) -> JSONResponse:
        return error_response(
            400, "VALIDATION_ERROR", "Request validation failed", request_id(request)
        )

    @app.exception_handler(AgentPlanningError)
    async def planning_error(
        request: Request, error: AgentPlanningError
    ) -> JSONResponse:
        logger.exception("Agent planning failed", exc_info=error)
        return error_response(
            500, "AGENT_PLANNING_FAILED", "Agent planning failed", request_id(request)
        )

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, error: Exception) -> JSONResponse:
        logger.exception("Unexpected Agent Service error", exc_info=error)
        return error_response(
            500, "INTERNAL_SERVER_ERROR", "Internal server error", request_id(request)
        )


def create_runtime_app() -> FastAPI:
    return create_app(get_settings())
