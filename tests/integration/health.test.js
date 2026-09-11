import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createNestApplication } from "../../src/app/bootstrap.js";

describe("Nest HTTP application", () => {
  let app;
  beforeAll(async () => {
    app = await createNestApplication();
  });
  afterAll(async () => {
    await app.close();
  });

  it("serves liveness through the Nest HTTP application", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/health/live")
      .set("x-request-id", "01ARZ3NDEKTSV4RRFFQ69G5FAV")
      .expect(200);
    expect(response.body).toEqual({
      data: { status: "ok" },
      meta: null,
      requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
  });

  it("preserves validation and error envelopes", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .set("x-request-id", "01ARZ3NDEKTSV4RRFFQ69G5FB0")
      .send({ name: "", password: "weak" })
      .expect(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.fieldErrors).toBeTruthy();
    expect(response.body.requestId).toBe("01ARZ3NDEKTSV4RRFFQ69G5FB0");
  });

  it("runs authentication middleware through controller dispatch", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/admin/dashboard")
      .set("x-request-id", "01ARZ3NDEKTSV4RRFFQ69G5FB1")
      .expect(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("uses the standard not-found envelope", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/not-a-route")
      .set("x-request-id", "01ARZ3NDEKTSV4RRFFQ69G5FB2")
      .expect(404);
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
      requestId: "01ARZ3NDEKTSV4RRFFQ69G5FB2",
    });
  });
});
