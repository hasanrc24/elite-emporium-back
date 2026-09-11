import { describe, expect, it } from "vitest";
import {
  effectivePermissionKeys,
  userAuthInclude,
} from "../../src/modules/auth/authorization.js";

describe("authorization", () => {
  it("filters disabled role permissions without requiring a user-role allow column", () => {
    const roleInclude = userAuthInclude.find((entry) => entry.as === "roles");
    const permissionInclude = roleInclude.include.find(
      (entry) => entry.as === "permissions",
    );

    expect(roleInclude.through).toEqual({ attributes: [] });
    expect(permissionInclude.through).toEqual({
      attributes: [],
      where: { allow: true },
    });
  });

  it("applies explicit permission denies after grants", () => {
    const permissions = effectivePermissionKeys({
      roles: [
        {
          key: "support",
          permissions: [{ key: "orders.view" }, { key: "customers.view" }],
        },
      ],
      permissionOverrides: [
        { allow: true, permission: { key: "reports.view" } },
        { allow: false, permission: { key: "customers.view" } },
      ],
    });

    expect(permissions).toEqual(["orders.view", "reports.view"]);
  });
});
