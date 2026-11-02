import { createDecipheriv } from "node:crypto";
import { createReadStream } from "node:fs";
import { Writable } from "node:stream";
import { open, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import path from "node:path";
import { env } from "../src/config/env.js";

const file = path.resolve(process.argv[2] || "");
if (!process.argv[2] || process.env.RESTORE_CONFIRM !== env.DB_NAME)
  throw new Error(
    `Usage: RESTORE_CONFIRM=${env.DB_NAME} npm run backup:restore -- /absolute/backup.sql.gz.enc`,
  );
const info = await stat(file);
if (!info.isFile() || info.size < 37) throw new Error("Invalid backup file.");
const handle = await open(file, "r");
const header = Buffer.alloc(20);
const tag = Buffer.alloc(16);
await handle.read(header, 0, 20, 0);
await handle.read(tag, 0, 16, info.size - 16);
await handle.close();
if (header.subarray(0, 8).toString() !== "EEBACK01")
  throw new Error("Unsupported backup format.");
const decipher = () => {
  const value = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(env.ENCRYPTION_MASTER_KEY, "hex"),
    header.subarray(8),
  );
  value.setAuthTag(tag);
  return value;
};
const ciphertext = () =>
  createReadStream(file, { start: 20, end: info.size - 17 });
// GCM authenticates only at the end of the stream, so verify the whole file
// before any decrypted SQL reaches the database.
await pipeline(
  ciphertext(),
  decipher(),
  createGunzip(),
  new Writable({ write: (_chunk, _encoding, done) => done() }),
);
const mysql = spawn(
  "mysql",
  [
    "--host",
    env.DB_HOST,
    "--port",
    String(env.DB_PORT),
    "--user",
    env.DB_USER,
    env.DB_NAME,
  ],
  {
    stdio: ["pipe", "inherit", "inherit"],
    // MYSQL_PWD keeps the password out of the world-readable process list.
    env: { ...process.env, MYSQL_PWD: env.DB_PASSWORD },
  },
);
await Promise.all([
  pipeline(ciphertext(), decipher(), createGunzip(), mysql.stdin),
  new Promise<void>((resolve, reject) => {
    mysql.once("error", reject);
    mysql.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`mysql exited with ${code}`)),
    );
  }),
]);
process.stdout.write(`Restored ${file} into ${env.DB_NAME}.\n`);
