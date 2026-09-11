import { createDecipheriv } from "node:crypto";
import { createReadStream } from "node:fs";
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
const decipher = createDecipheriv(
  "aes-256-gcm",
  Buffer.from(env.ENCRYPTION_MASTER_KEY, "hex"),
  header.subarray(8),
);
decipher.setAuthTag(tag);
const mysql = spawn(
  "mysql",
  [
    "--host",
    env.DB_HOST,
    "--port",
    String(env.DB_PORT),
    "--user",
    env.DB_USER,
    `--password=${env.DB_PASSWORD}`,
    env.DB_NAME,
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);
await Promise.all([
  pipeline(
    createReadStream(file, { start: 20, end: info.size - 17 }),
    decipher,
    createGunzip(),
    mysql.stdin,
  ),
  new Promise<void>((resolve, reject) => {
    mysql.once("error", reject);
    mysql.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`mysql exited with ${code}`)),
    );
  }),
]);
process.stdout.write(`Restored ${file} into ${env.DB_NAME}.\n`);
