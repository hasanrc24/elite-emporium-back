import { describe, expect, it } from "vitest";
import express from "express";
import { z } from "zod";
import { validateRequest } from "../../src/app/middleware/validate.js";

const expressRequest = (url) => {
  const request = Object.create(express.request);
  request.app = express();
  request.url = url;
  return request;
};

describe("validateRequest", () => {
  it("replaces Express 5 getter-only query with parsed data", () => {
    const request = expressRequest("/returns/eligibility?orderId=7&extra=1");
    validateRequest(request, z.object({ orderId: z.coerce.number() }), "query");
    expect(request.query).toEqual({ orderId: 7 });
  });

  it("raises a validation error envelope for invalid input", () => {
    const request = expressRequest("/returns/eligibility");
    expect(() =>
      validateRequest(request, z.object({ orderId: z.string() }), "query"),
    ).toThrow(expect.objectContaining({ status: 422 }));
  });
});
