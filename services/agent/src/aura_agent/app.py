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
from aura_agent.inference import InferenceClient, LlamaCppInferenceClient
from aura_agent.logging import configure_logging
from aura_agent.planner import (
    AgentPlanningError,
    AgentService,
    DeterministicDevelopmentPlanner,
    Planner,
    SelfHostedLlmPlanner,
)

REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
logger = logging.getLogger("aura.agent")


def create_app(
    settings: Settings,
    planner: Planner | None = None,
    inference_client: InferenceClient | None = None,
) -> FastAPI:
    configure_logging(settings.log_level)
    managed_inference: InferenceClient | None = None
    if planner is not None:
        selected_planner = planner
    elif settings.agent_planner_mode == "deterministic":
        selected_planner = DeterministicDevelopmentPlanner()
    else:
        managed_inference = inference_client or _create_inference_client(settings)
        selected_planner = SelfHostedLlmPlanner(
            managed_inference, _required_model_name(settings)
        )
    service = AgentService(selected_planner)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        started = time.perf_counter()
        try:
            if managed_inference is not None:
                await managed_inference.initialize()
            app.state.ready = True
            logger.info(
                "Agent Service initialized",
                extra={
                    "plannerMode": settings.agent_planner_mode,
                    "modelRuntime": (
                        "llama.cpp" if settings.agent_planner_mode == "llm" else None
                    ),
                    "modelName": settings.llm_model_name,
                    "loadDurationMs": round((time.perf_counter() - started) * 1000, 3),
                },
            )
            yield
        finally:
            app.state.ready = False
            if managed_inference is not None:
                await managed_inference.close()
            logger.info("Agent Service stopped")

    app = FastAPI(
        title="AURA Agent Service", docs_url=None, redoc_url=None, lifespan=lifespan
    )
    app.state.ready = False

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
    async def ready(request: Request) -> dict[str, str]:
        if not request.app.state.ready:
            raise ServiceNotReadyError
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


class ServiceNotReadyError(Exception):
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

    @app.exception_handler(ServiceNotReadyError)
    async def not_ready_error(
        request: Request, _: ServiceNotReadyError
    ) -> JSONResponse:
        return error_response(
            503, "SERVICE_NOT_READY", "Service is not ready", request_id(request)
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


def _required_model_name(settings: Settings) -> str:
    if settings.llm_model_name is None:
        raise ValueError("LLM model name is required")
    return settings.llm_model_name


def _create_inference_client(settings: Settings) -> LlamaCppInferenceClient:
    if settings.llm_base_url is None:
        raise ValueError("LLM base URL is required")
    return LlamaCppInferenceClient(
        base_url=str(settings.llm_base_url),
        model_name=_required_model_name(settings),
        max_output_tokens=settings.llm_max_output_tokens,
        temperature=settings.llm_temperature,
        timeout_seconds=settings.llm_request_timeout_seconds,
    )
