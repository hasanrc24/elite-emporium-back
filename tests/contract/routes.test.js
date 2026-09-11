import { describe, expect, it } from "vitest";
import { createNestApplication } from "../../src/app/bootstrap.js";
import { openapiDocument } from "../../src/app/core.controller.js";

const normalizePath = (path) =>
  path.replace(/^\/api\/v1/, "").replace(/:([A-Za-z0-9_]+)/g, "{$1}") || "/";

function resolveReference(document, value) {
  if (!value.$ref) return value;
  return value.$ref
    .replace(/^#\//, "")
    .split("/")
    .reduce((current, segment) => current[segment], document);
}

describe("OpenAPI route contract", () => {
  it("implements every documented operation using Nest controllers", async () => {
    const app = await createNestApplication();
    const expressApp = app.getHttpAdapter().getInstance();
    const actual = new Set();
    for (const layer of expressApp.router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        actual.add(
          `${method.toUpperCase()} ${normalizePath(layer.route.path)}`,
        );
      }
    }

    const documented = new Set();
    for (const [path, item] of Object.entries(openapiDocument.paths)) {
      const pathItem = resolveReference(openapiDocument, item);
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        if (pathItem[method]) documented.add(`${method.toUpperCase()} ${path}`);
      }
    }
    const missing = [...documented].filter(
      (operation) => !actual.has(operation),
    );
    const undocumented = [...actual].filter(
      (operation) => !documented.has(operation),
    );
    await app.close();
    expect(missing).toEqual([]);
    expect(undocumented).toEqual([]);
  });
});
