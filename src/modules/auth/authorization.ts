import { Op } from "sequelize";
import {
  MfaMethod,
  Permission,
  Role,
  UserPermissionOverride,
} from "../../db/models.js";

export const userAuthInclude = [
  {
    model: Role,
    as: "roles",
    where: { active: true },
    required: false,
    through: { attributes: [] },
    include: [
      {
        model: Permission,
        as: "permissions",
        through: { attributes: [], where: { allow: true } },
      },
    ],
  },
  {
    model: UserPermissionOverride,
    as: "permissionOverrides",
    required: false,
    include: [{ model: Permission, as: "permission" }],
  },
  {
    model: MfaMethod,
    as: "mfaMethods",
    required: false,
    where: { confirmedAt: { [Op.ne]: null }, disabledAt: null },
    attributes: ["id", "type", "confirmedAt"],
  },
];

interface PermissionRecord {
  key: string;
}
interface RoleRecord {
  key: string;
  permissions?: PermissionRecord[];
}
interface OverrideRecord {
  allow: boolean;
  permission?: PermissionRecord;
}
interface AuthorizedUser {
  roles?: RoleRecord[];
  permissionOverrides?: OverrideRecord[];
}

export function effectivePermissionKeys(user: AuthorizedUser): string[] {
  const owner = user.roles?.some((role) => role.key === "owner");
  const granted = new Set(
    user.roles?.flatMap(
      (role) => role.permissions?.map((permission) => permission.key) || [],
    ) || [],
  );
  if (owner) return [...granted].sort();
  const overrides = user.permissionOverrides || [];
  for (const override of overrides) {
    const key = override.permission?.key;
    if (key && override.allow) granted.add(key);
  }
  for (const override of overrides) {
    const key = override.permission?.key;
    if (key && !override.allow) granted.delete(key);
  }
  return [...granted].sort();
}
