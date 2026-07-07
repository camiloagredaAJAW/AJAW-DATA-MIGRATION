import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  adminUpdateFieldMapping,
  getFieldMappingById,
  listFieldMappings,
} from "../../repos/mappingRepo.js";
import type { MigrationController } from "../../migration/controller.js";

const listQuerySchema = z.object({
  source_db: z.string().optional(),
  source_table: z.string().optional(),
});

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const updateBodySchema = z
  .object({
    destinationField: z.string().nullable().optional(),
    transform: z.string().nullable().optional(),
  })
  .strict();

const errorsQuerySchema = z.object({
  runId: z.coerce.number().int().positive().optional(),
  countryCode: z.string().optional(),
  resolved: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

const errorIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

function validationError(message: string): { error: { code: string; message: string } } {
  return { error: { code: "validation_error", message } };
}

function notFoundError(message: string): { error: { code: string; message: string } } {
  return { error: { code: "not_found", message } };
}

function conflictError(message: string): { error: { code: string; message: string } } {
  return { error: { code: "conflict", message } };
}

/**
 * Registers the `/admin/api/*` BFF data + control routes onto the
 * session-guarded scope from `adminPlugin.ts` (`requireAdminSession` +
 * `requireCsrfHeader` are already applied at that scope, so they are not
 * re-registered here). Deliberately mirrors the thin HTTP wiring in
 * `fieldMappings.ts`/`migrationControl.ts` route-for-route: every response
 * shape and status-code mapping matches its `/api/*` counterpart exactly,
 * because both surfaces call the SAME repo functions / `MigrationController`
 * instance in-process — no HTTP loopback, no duplicated business logic.
 */
export function registerAdminBffRoutes(
  fastify: FastifyInstance,
  db: Database.Database,
  controller: MigrationController | undefined,
): void {
  fastify.get("/admin/api/field-mappings", async (request, reply) => {
    const parsedQuery = listQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send(validationError(parsedQuery.error.message));
    }

    const rows = listFieldMappings(db, {
      sourceDb: parsedQuery.data.source_db,
      sourceTable: parsedQuery.data.source_table,
    });
    return reply.send({ data: rows });
  });

  fastify.get("/admin/api/field-mappings/:id", async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send(validationError(parsedParams.error.message));
    }

    const row = getFieldMappingById(db, parsedParams.data.id);
    if (row === null) {
      request.log.warn(
        { route: "GET /admin/api/field-mappings/:id", reason: "not_found" },
        "admin field-mapping lookup failed",
      );
      return reply.code(404).send(notFoundError("field_mapping not found"));
    }
    return reply.send({ data: row });
  });

  fastify.put("/admin/api/field-mappings/:id", async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send(validationError(parsedParams.error.message));
    }

    const parsedBody = updateBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send(validationError(parsedBody.error.message));
    }

    const updated = adminUpdateFieldMapping(db, parsedParams.data.id, parsedBody.data);
    if (updated === null) {
      request.log.warn(
        { route: "PUT /admin/api/field-mappings/:id", reason: "not_found" },
        "admin field-mapping update failed",
      );
      return reply.code(404).send(notFoundError("field_mapping not found"));
    }
    return reply.send({ data: updated });
  });

  // Status/errors/migration-control routes need the shared controller, which
  // `buildServer()` only constructs when `migrationDeps` was supplied (see
  // server.ts) — mirrors the same optionality as `/api/migration/*`.
  if (controller === undefined) {
    return;
  }

  fastify.get("/admin/api/status", async (_request, reply) => {
    return reply.send({ data: controller.status() });
  });

  fastify.get("/admin/api/errors", async (request, reply) => {
    const parsedQuery = errorsQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send(validationError(parsedQuery.error.message));
    }

    const { runId, countryCode, resolved, limit, offset } = parsedQuery.data;
    const { rows, total } = controller.listErrors({
      runId,
      countryCode,
      resolved: resolved === undefined ? undefined : resolved === "true",
      limit,
      offset,
    });
    return reply.send({ data: rows, total });
  });

  fastify.post("/admin/api/errors/:id/retry", async (request, reply) => {
    const parsedParams = errorIdParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send(validationError(parsedParams.error.message));
    }

    const outcome = await controller.retry(parsedParams.data.id);
    switch (outcome.outcome) {
      case "not_found":
        request.log.warn(
          { route: "POST /admin/api/errors/:id/retry", reason: "not_found" },
          "admin error retry failed",
        );
        return reply.code(404).send(notFoundError("import_errors row not found"));
      case "already_resolved":
        request.log.warn(
          { route: "POST /admin/api/errors/:id/retry", reason: "already_resolved" },
          "admin error retry failed",
        );
        return reply.code(409).send(conflictError("import_errors row is already resolved"));
      case "retry_in_progress":
        request.log.warn(
          { route: "POST /admin/api/errors/:id/retry", reason: "retry_in_progress" },
          "admin error retry failed",
        );
        return reply.code(409).send(conflictError("import_errors row retry is already in progress"));
      case "resolved":
        return reply.send({ data: { outcome: "resolved", importError: outcome.importError } });
      case "failed":
        request.log.warn(
          { route: "POST /admin/api/errors/:id/retry", reason: "failed", failureReason: outcome.reason },
          "admin error retry failed",
        );
        return reply.code(422).send({
          data: { outcome: "failed", importError: outcome.importError, reason: outcome.reason },
        });
    }
  });

  fastify.post("/admin/api/migration/start", async (request, reply) => {
    const result = controller.start();
    if (result.outcome === "conflict") {
      request.log.warn(
        { route: "POST /admin/api/migration/start", reason: result.message },
        "admin migration control action rejected",
      );
      return reply.code(409).send(conflictError(result.message));
    }
    return reply.code(202).send({ data: result.run });
  });

  fastify.post("/admin/api/migration/pause", async (request, reply) => {
    const result = controller.pause();
    if (result.outcome === "conflict") {
      request.log.warn(
        { route: "POST /admin/api/migration/pause", reason: result.message },
        "admin migration control action rejected",
      );
      return reply.code(409).send(conflictError(result.message));
    }
    return reply.send({ data: result.run });
  });

  fastify.post("/admin/api/migration/resume", async (request, reply) => {
    const result = controller.resume();
    if (result.outcome === "conflict") {
      request.log.warn(
        { route: "POST /admin/api/migration/resume", reason: result.message },
        "admin migration control action rejected",
      );
      return reply.code(409).send(conflictError(result.message));
    }
    return reply.code(202).send({ data: result.run });
  });

  fastify.post("/admin/api/catalog/refresh", async (_request, reply) => {
    const result = await controller.refreshCatalog();
    return reply.send({ data: result });
  });

  fastify.post("/admin/api/migration/stop", async (request, reply) => {
    const result = controller.stop();
    if (result.outcome === "conflict") {
      request.log.warn(
        { route: "POST /admin/api/migration/stop", reason: result.message },
        "admin migration control action rejected",
      );
      return reply.code(409).send(conflictError(result.message));
    }
    return reply.send({ data: result.run });
  });
}
