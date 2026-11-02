/**
 * Collapses an IP address to its network prefix: /24 for IPv4 and /64 for
 * IPv6. Used for session metadata and the `ip_prefix` risk blocklist so the
 * full address is never stored.
 */
export function ipPrefix(value: unknown): string | null {
  const ip = String(value || "")
    .trim()
    .replace(/^::ffff:/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip))
    return `${ip.split(".").slice(0, 3).join(".")}.0/24`;
  if (ip.includes(":")) return `${ip.split(":").slice(0, 4).join(":")}::/64`;
  return ip.slice(0, 64) || null;
}
