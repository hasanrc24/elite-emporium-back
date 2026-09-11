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
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const normalized = address.toLowerCase();
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
