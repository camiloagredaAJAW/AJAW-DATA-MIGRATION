import { describe, expect, it } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../../src/db/migrate.js";
import { upsertFieldMapping } from "../../../src/repos/mappingRepo.js";
import { buildServer } from "../../../src/api/server.js";
import type { AuthConfig } from "../../../src/api/auth/authGuard.js";

const migrationsDir = path.join(process.cwd(), "src", "migrations");

const authConfig: AuthConfig = {
  username: "admin",
  password: "s3cret",
  internalApiKey: "internal-key-123",
};

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function validHeaders(): Record<string, string> {
  return {
    authorization: basicAuthHeader(authConfig.username, authConfig.password),
    "x-internal-api-key": authConfig.internalApiKey,
  };
}

function seededDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, migrationsDir);
  upsertFieldMapping(db, {
    sourceDb: "ar",
    sourceTable: "companies",
    sourceColumn: "legal_name",
    destinationDomain: "AiSearchResults",
    destinationField: "title",
    additionalInfoKey: null,
    confidence: "high",
    note: null,
    origin: "bootstrap",
  });
  return db;
}

describe("field_mappings CRUD routes", () => {
  it("lists all field mappings when no filter is given", async () => {
    const db = seededDb();
    const server = buildServer({ db, authConfig });

    const response = await server.inject({
      method: "GET",
      url: "/api/field-mappings",
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].sourceColumn).toBe("legal_name");
  });

  it("filters the list by source_db and source_table query params", async () => {
    const db = seededDb();
    upsertFieldMapping(db, {
      sourceDb: "cl",
      sourceTable: "companies",
      sourceColumn: "razon_social",
      destinationDomain: "AiSearchResults",
      destinationField: "title",
      additionalInfoKey: null,
      confidence: "high",
      note: null,
      origin: "bootstrap",
    });
    const server = buildServer({ db, authConfig });

    const response = await server.inject({
      method: "GET",
      url: "/api/field-mappings?source_db=cl&source_table=companies",
      headers: validHeaders(),
    });

    const body = response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].sourceDb).toBe("cl");
  });

  it("reads a single field mapping by id", async () => {
    const db = seededDb();
    const server = buildServer({ db, authConfig });
    const row = db.prepare(`SELECT id FROM field_mappings LIMIT 1`).get() as { id: number };

    const response = await server.inject({
      method: "GET",
      url: `/api/field-mappings/${row.id}`,
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.id).toBe(row.id);
  });

  it("returns 404 for a non-existent id on read", async () => {
    const db = seededDb();
    const server = buildServer({ db, authConfig });

    const response = await server.inject({
      method: "GET",
      url: "/api/field-mappings/999999",
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(404);
  });

  it("updates destination_field and forces origin to admin", async () => {
    const db = seededDb();
    const server = buildServer({ db, authConfig });
    const row = db.prepare(`SELECT id FROM field_mappings LIMIT 1`).get() as { id: number };

    const response = await server.inject({
      method: "PUT",
      url: `/api/field-mappings/${row.id}`,
      headers: validHeaders(),
      payload: { destinationField: "additionalInfo" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.destinationField).toBe("additionalInfo");
    expect(body.data.origin).toBe("admin");

    const persisted = db
      .prepare(`SELECT destination_field, origin FROM field_mappings WHERE id = ?`)
      .get(row.id) as { destination_field: string; origin: string };
    expect(persisted.destination_field).toBe("additionalInfo");
    expect(persisted.origin).toBe("admin");
  });

  it("returns 404 when updating a non-existent id", async () => {
    const db = seededDb();
    const server = buildServer({ db, authConfig });

    const response = await server.inject({
      method: "PUT",
      url: "/api/field-mappings/999999",
      headers: validHeaders(),
      payload: { destinationField: "title" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 400 for an invalid update payload (wrong type)", async () => {
    const db = seededDb();
    const server = buildServer({ db, authConfig });
    const row = db.prepare(`SELECT id FROM field_mappings LIMIT 1`).get() as { id: number };

    const response = await server.inject({
      method: "PUT",
      url: `/api/field-mappings/${row.id}`,
      headers: validHeaders(),
      payload: { destinationField: 12345 },
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 for an invalid id param (non-numeric)", async () => {
    const db = seededDb();
    const server = buildServer({ db, authConfig });

    const response = await server.inject({
      method: "GET",
      url: "/api/field-mappings/not-a-number",
      headers: validHeaders(),
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects list requests without valid auth, returning no data", async () => {
    const db = seededDb();
    const server = buildServer({ db, authConfig });

    const response = await server.inject({ method: "GET", url: "/api/field-mappings" });

    expect(response.statusCode).toBe(401);
    expect(response.json().data).toBeUndefined();
  });

  it("rejects update requests with a valid Basic Auth but missing API key", async () => {
    const db = seededDb();
    const server = buildServer({ db, authConfig });
    const row = db.prepare(`SELECT id FROM field_mappings LIMIT 1`).get() as { id: number };

    const response = await server.inject({
      method: "PUT",
      url: `/api/field-mappings/${row.id}`,
      headers: { authorization: basicAuthHeader(authConfig.username, authConfig.password) },
      payload: { destinationField: "title" },
    });

    expect(response.statusCode).toBe(401);
  });
});
