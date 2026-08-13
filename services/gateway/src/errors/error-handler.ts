import type { FastifyError, FastifyInstance } from "fastify";

import { AppError } from "./app-error.js";
import { createErrorResponse } from "./error-response.js";

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    void reply
      .status(404)
      .send(
        createErrorResponse("ROUTE_NOT_FOUND", "Route not found", request.id),
      );
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      request.log.warn({ err: error, errorCode: error.code }, "Request failed");
      void reply
        .status(error.httpStatus)
        .send(
          createErrorResponse(
            error.code,
            error.message,
            request.id,
            error.details,
          ),
        );
      return;
    }

    if (error.validation !== undefined) {
      request.log.warn({ err: error }, "Request validation failed");
      void reply
        .status(400)
        .send(
          createErrorResponse(
            "VALIDATION_ERROR",
            "Request validation failed",
            request.id,
          ),
        );
      return;
    }

    request.log.error({ err: error }, "Unhandled request error");
    void reply
      .status(500)
      .send(
        createErrorResponse(
          "INTERNAL_SERVER_ERROR",
          "Internal server error",
          request.id,
        ),
      );
  });
}
