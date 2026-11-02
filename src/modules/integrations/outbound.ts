import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

/**
 * Address ranges an outbound integration (webhook, SMS, SMTP) must never
 * reach: loopback, private, link-local, CGNAT, multicast, reserved, and their
 * IPv6 equivalents. IPv4-mapped IPv6 addresses are matched against the IPv4
 * rules by BlockList.
 */
const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const)
  blocked.addSubnet(network, prefix, "ipv6");

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) return blocked.check(address, "ipv6");
  return true;
}

function unsafeHostError(): Error {
  return Object.assign(
    new Error("Integration URL resolved to a blocked address."),
    { code: "UNSAFE_INTEGRATION_HOST" },
  );
}

/** Resolves a hostname and rejects it when any address is non-public. */
export async function assertPublicHostname(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => isBlockedAddress(address))
  )
    throw unsafeHostError();
}

async function assertPublicUrl(urlValue: string): Promise<URL> {
  const url = new URL(urlValue);
  if (url.protocol !== "https:" || url.username || url.password)
    throw Object.assign(
      new Error("Integration URL must use HTTPS without credentials."),
      { code: "UNSAFE_INTEGRATION_URL" },
    );
  await assertPublicHostname(url.hostname);
  return url;
}

/**
 * DNS lookup used for the actual socket connection. Re-validating here pins the
 * check to the address that is connected to, which defeats DNS rebinding
 * between the pre-flight check and the request.
 */
function guardedLookup(
  hostname: string,
  options: RuntimeValue,
  callback: RuntimeValue,
): void {
  dnsLookup(
    hostname,
    { ...options, all: true },
    (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => {
      if (error) return callback(error);
      if (
        !addresses.length ||
        addresses.some(({ address }) => isBlockedAddress(address))
      )
        return callback(unsafeHostError());
      if (options?.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    },
  );
}

/**
 * POSTs to a public HTTPS endpoint without following redirects. The response
 * body is capped so a hostile endpoint cannot exhaust worker memory.
 */
export async function postToPublicUrl(
  urlValue: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs = 10_000,
): Promise<{
  status: number;
  ok: boolean;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}> {
  const url = await assertPublicUrl(urlValue);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-length": String(Buffer.byteLength(body)),
        },
        lookup: guardedLookup,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          if (size >= 65_536) return;
          chunks.push(chunk);
          size += chunk.length;
        });
        response.on("error", reject);
        response.on("end", () => {
          const status = response.statusCode || 0;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            headers: response.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}
