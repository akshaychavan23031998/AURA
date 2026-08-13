import type { FastifyError, FastifyInstance } from "fastify";

import { createErrorResponse } from "./error-response.js";
import { ToolError } from "./tool-error.js";

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    void reply
      .status(404)
      .send(
        createErrorResponse("ROUTE_NOT_FOUND", "Route not found", request.id),
      );
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ToolError) {
      const log =
        error.httpStatus >= 500
          ? request.log.error.bind(request.log)
          : request.log.warn.bind(request.log);
      log({ err: error, errorCode: error.code }, "Tool request failed");
      void reply
        .status(error.httpStatus)
        .send(createErrorResponse(error.code, error.message, request.id));
      return;
    }
    if (
      error.validation !== undefined ||
      (error.statusCode !== undefined &&
        error.statusCode >= 400 &&
        error.statusCode < 500)
    ) {
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
