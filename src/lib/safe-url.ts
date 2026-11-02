import dns from "node:dns/promises";
import net from "node:net";
import { env } from "../config/env.js";
import { AppError } from "./errors.js";

const allowedHosts = new Set(
  env.INTEGRATION_ALLOWED_HOSTS.split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const normalized = address.toLowerCase();
  // IPv4-mapped/translated IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  // reaches the embedded IPv4 host; check it as IPv4 or reject outright.
  const mapped = /^(?:(?:0{1,4}:){5}|::)ffff:(?:0{1,4}:)?(.+)$/.exec(
    normalized,
  );
  if (mapped) return net.isIPv4(mapped[1]) ? isPrivateAddress(mapped[1]) : true;
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}

export async function validateOutboundUrl(
  input: string,
  extraAllowedHosts: string[] = [],
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw AppError.unprocessable("INVALID_URL", "Enter a valid HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw AppError.unprocessable(
      "UNSAFE_URL",
      "Only credential-free HTTPS URLs are allowed.",
    );
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.has(host) && !extraAllowedHosts.includes(host))
    throw AppError.unprocessable(
      "HOST_NOT_ALLOWED",
      "This integration host is not allowlisted.",
    );
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => isPrivateAddress(address))
  )
    throw AppError.unprocessable(
      "UNSAFE_HOST",
      "This host resolves to a private or restricted address.",
    );
  return url;
}
