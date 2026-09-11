import { Op } from "sequelize";

function boundary(value: unknown, end = false): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  const date = new Date(`${value}T00:00:00.000+06:00`);
  if (Number.isNaN(date.getTime())) return null;
  if (end) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

/** Builds a Dhaka-calendar-day range with an exclusive upper bound. */
export function dateRangeWhere(
  query: { from?: unknown; to?: unknown } | null | undefined,
  field = "createdAt",
) {
  const from = boundary(query?.from);
  const to = boundary(query?.to, true);
  if (!from && !to) return {};
  return {
    [field]: {
      ...(from ? { [Op.gte]: from } : {}),
      ...(to ? { [Op.lt]: to } : {}),
    },
  };
}
