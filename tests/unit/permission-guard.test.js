import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
  PermissionGuard,
  Permissions,
} from "../../src/app/request-security.js";

class Controller {
  refund() {}
  view() {}
  open() {}
}

// Plain JS tests are not decorator-transformed, so apply them as TS would
// (bottom-up) for a method with two stacked @Permissions decorators.
const decorate = (method, ...decorators) => {
  const descriptor = Object.getOwnPropertyDescriptor(
    Controller.prototype,
    method,
  );
  for (const decorator of decorators.reverse())
    decorator(Controller.prototype, method, descriptor);
};
decorate(
  "refund",
  Permissions("returns.manage"),
  Permissions("payments.refund"),
);
decorate("view", Permissions("orders.view"));

const contextFor = (handler, granted) => ({
  getHandler: () => handler,
  switchToHttp: () => ({
    getRequest: () => ({ auth: { permissions: new Set(granted) } }),
  }),
});

describe("PermissionGuard", () => {
  const guard = new PermissionGuard();
  const { prototype } = Controller;

  it("requires every stacked permission", () => {
    expect(() =>
      guard.canActivate(contextFor(prototype.refund, ["returns.manage"])),
    ).toThrow(expect.objectContaining({ status: 403 }));
    expect(
      guard.canActivate(
        contextFor(prototype.refund, ["returns.manage", "payments.refund"]),
      ),
    ).toBe(true);
  });

  it("enforces a single permission and allows undecorated handlers", () => {
    expect(() => guard.canActivate(contextFor(prototype.view, []))).toThrow(
      expect.objectContaining({ status: 403 }),
    );
    expect(guard.canActivate(contextFor(prototype.open, []))).toBe(true);
  });
});
