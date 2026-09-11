const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:4000";

for (const [path, expectedStatus] of [
  ["/api/v1/health/live", 200],
  ["/api/v1/openapi.json", 200],
]) {
  const response = await fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== expectedStatus)
    throw new Error(`${path} returned ${response.status}`);
}

const missing = await fetch(`${baseUrl}/api/v1/__smoke_missing`, {
  signal: AbortSignal.timeout(5_000),
});
if (missing.status !== 404)
  throw new Error(`Missing route returned ${missing.status}`);
process.stdout.write("Docker smoke checks passed.\n");
