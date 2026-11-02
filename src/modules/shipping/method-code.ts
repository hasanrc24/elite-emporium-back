/**
 * Stable code for a delivery method an admin adds from the settings page.
 * Codes are what orders and the checkout refer to, so they are generated once
 * (readable prefix + random suffix for uniqueness) and never edited.
 */
export function generateMethodCode(label: string, suffix: string) {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  const clean = suffix
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 6);
  return `${slug || "delivery"}_${clean || "x"}`;
}
