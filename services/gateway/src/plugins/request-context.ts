import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { FastifyInstance } from "fastify";

const REQUEST_ID_HEADER = "x-request-id";
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function resolveRequestId(request: IncomingMessage): string {
  const incomingId = request.headers[REQUEST_ID_HEADER];
  return typeof incomingId === "string" && SAFE_REQUEST_ID.test(incomingId)
    ? incomingId
    : randomUUID();
}

export function registerRequestContext(app: FastifyInstance): void {
  app.addHook("onRequest", (request, reply, done) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });
}
