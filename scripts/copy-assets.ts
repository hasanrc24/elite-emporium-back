import { mkdir, copyFile } from "node:fs/promises";

await mkdir(new URL("../dist/src/docs/", import.meta.url), { recursive: true });
await copyFile(
  new URL("../src/docs/openapi.yaml", import.meta.url),
  new URL("../dist/src/docs/openapi.yaml", import.meta.url),
);
