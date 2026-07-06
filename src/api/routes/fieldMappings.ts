import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  adminUpdateFieldMapping,
  getFieldMappingById,
  listFieldMappings,
} from "../../repos/mappingRepo.js";

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

function validationError(message: string): { error: { code: string; message: string } } {
  return { error: { code: "validation_error", message } };
}

function notFoundError(message: string): { error: { code: string; message: string } } {
  return { error: { code: "not_found", message } };
}

/**
 * Registers the read + admin-update `field_mappings` routes. Create/delete
 * are intentionally out of scope for this slice — the registry is
 * seeded/bootstrapped, not manually authored from scratch. Every route runs
 * behind whatever auth hook the caller registered on `fastify` beforehand
 * (see `registerAuthGuard`).
 */
export function registerFieldMappingsRoutes(
  fastify: FastifyInstance,
  db: Database.Database,
): void {
  fastify.get("/api/field-mappings", async (request, reply) => {
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

  fastify.get("/api/field-mappings/:id", async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send(validationError(parsedParams.error.message));
    }

    const row = getFieldMappingById(db, parsedParams.data.id);
    if (row === null) {
      return reply.code(404).send(notFoundError("field_mapping not found"));
    }
    return reply.send({ data: row });
  });

  fastify.put("/api/field-mappings/:id", async (request, reply) => {
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
      return reply.code(404).send(notFoundError("field_mapping not found"));
    }
    return reply.send({ data: updated });
  });
}
