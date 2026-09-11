import { describe, expect, it } from "vitest";
import { AuthSession, User } from "../../src/db/models.js";
import { userAuthInclude } from "../../src/modules/auth/authorization.js";

describe("model attribute access", () => {
  it("preserves a loaded user's ID when creating a login session", () => {
    const id = "01M27VF3WKD4G8EB3FT9335FJ4";
    const user = User.build(
      { id, roleVersion: 3 },
      { isNewRecord: false, raw: true },
    );

    expect(user.id).toBe(id);
    expect(user.roleVersion).toBe(3);
    const session = AuthSession.build({ userId: user.id });
    expect(session.getDataValue("userId")).toBe(id);
  });

  it("preserves eagerly loaded roles and permission overrides", () => {
    const user = User.build(
      {
        id: "01M27VF3WKD4G8EB3FT9335FJ4",
        roles: [{ id: "01M27VF3WKN123ABYYTX78DJN5", key: "owner" }],
        permissionOverrides: [
          { id: "01M27VF3RYR8A63S5QHXSFXKW4", allow: false },
        ],
      },
      { isNewRecord: false, raw: true, include: userAuthInclude },
    );

    expect(user.roles).toHaveLength(1);
    expect(user.roles[0].key).toBe("owner");
    expect(user.permissionOverrides).toHaveLength(1);
    expect(user.permissionOverrides[0].allow).toBe(false);
  });
});
