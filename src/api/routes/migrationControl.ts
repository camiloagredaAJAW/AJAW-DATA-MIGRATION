import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MigrationController, MigrationControllerDeps } from "../../migration/controller.js";

/**
 * Re-exported under its historical name: this used to be defined here before
 * the controller extraction, and `server.ts`/tests still reference it as
 * `MigrationControlDeps`.
 */
export type MigrationControlDeps = MigrationControllerDeps;

function conflictError(message: string): { error: { code: string; message: string } } {
  return { error: { code: "conflict", message } };
}

function notFoundError(message: string): { error: { code: string; message: string } } {
  return { error: { code: "not_found", message } };
}

function validationError(message: string): { error: { code: string; message: string } } {
  return { error: { code: "validation_error", message } };
}

const errorsQuerySchema = z.object({
  runId: z.coerce.number().int().positive().optional(),
  countryCode: z.string().optional(),
  resolved: z.enum(["true", "false"]).optional(),
});

const errorIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/**
 * Registers the migration lifecycle-control routes: start/pause/resume/stop
 * plus a status readout. Every route runs behind whatever auth hook the
 * caller registered on `fastify` beforehand (see `registerAuthGuard`).
 *
 * Thin HTTP adapter over a shared `MigrationController` instance (see
 * `migration/controller.ts`) — no business logic lives here, only
 * outcome-to-status-code mapping and request validation. `buildServer`
 * constructs a single controller instance so the `/api` and (future)
 * `/admin` surfaces drive the exact same run/registry state.
 */
export function registerMigrationControlRoutes(
  fastify: FastifyInstance,
  controller: MigrationController,
): void {
  fastify.post("/api/migration/start", async (_request, reply) => {
    const result = controller.start();
    if (result.outcome === "conflict") {
      return reply.code(409).send(conflictError(result.message));
    }
    return reply.code(202).send({ data: result.run });
  });

  fastify.post("/api/migration/pause", async (_request, reply) => {
    const result = controller.pause();
    if (result.outcome === "conflict") {
      return reply.code(409).send(conflictError(result.message));
    }
    return reply.send({ data: result.run });
  });

  fastify.post("/api/migration/resume", async (_request, reply) => {
    const result = controller.resume();
    if (result.outcome === "conflict") {
      return reply.code(409).send(conflictError(result.message));
    }
    return reply.code(202).send({ data: result.run });
  });

  fastify.post("/api/migration/stop", async (_request, reply) => {
    const result = controller.stop();
    if (result.outcome === "conflict") {
      return reply.code(409).send(conflictError(result.message));
    }
    return reply.send({ data: result.run });
  });

  fastify.get("/api/migration/status", async (_request, reply) => {
    return reply.send({ data: controller.status() });
  });

  fastify.get("/api/migration/errors", async (request, reply) => {
    const parsedQuery = errorsQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send(validationError(parsedQuery.error.message));
    }

    const { runId, countryCode, resolved } = parsedQuery.data;
    const rows = controller.listErrors({
      runId,
      countryCode,
      resolved: resolved === undefined ? undefined : resolved === "true",
    });
    return reply.send({ data: rows });
  });

  fastify.post("/api/migration/errors/:id/retry", async (request, reply) => {
    const parsedParams = errorIdParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send(validationError(parsedParams.error.message));
    }

    const outcome = await controller.retry(parsedParams.data.id);
    switch (outcome.outcome) {
      case "not_found":
        return reply.code(404).send(notFoundError("import_errors row not found"));
      case "already_resolved":
        return reply.code(409).send(conflictError("import_errors row is already resolved"));
      case "resolved":
        return reply.send({ data: { outcome: "resolved", importError: outcome.importError } });
      case "failed":
        return reply.code(422).send({
          data: { outcome: "failed", importError: outcome.importError, reason: outcome.reason },
        });
    }
  });
}
