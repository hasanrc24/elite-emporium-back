import { createCipheriv, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { env } from "../src/config/env.js";

const magic = Buffer.from("EEBACK01");
const key = Buffer.from(env.ENCRYPTION_MASTER_KEY, "hex");
const timestamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
await mkdir(env.BACKUP_ROOT, { recursive: true, mode: 0o700 });
const destination = path.join(
  env.BACKUP_ROOT,
  `elite-emporium-${timestamp}.sql.gz.enc`,
);
const iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", key, iv);
// The image's Alpine "mysql-client" is the MariaDB client, whose mysqldump
// rejects the MySQL-only --set-gtid-purged option.
const mariaDbClient = /mariadb/i.test(
  execFileSync("mysqldump", ["--version"], { encoding: "utf8" }),
);
const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
output.write(Buffer.concat([magic, iv]));
try {
  const dump = spawn(
    "mysqldump",
    [
      "--single-transaction",
      "--quick",
      "--skip-lock-tables",
      ...(mariaDbClient ? [] : ["--set-gtid-purged=OFF"]),
      "--host",
      env.DB_HOST,
      "--port",
      String(env.DB_PORT),
      "--user",
      env.DB_USER,
      env.DB_NAME,
    ],
    {
      stdio: ["ignore", "pipe", "inherit"],
      // MYSQL_PWD keeps the password out of the world-readable process list.
      env: { ...process.env, MYSQL_PWD: env.DB_PASSWORD },
    },
  );
  await Promise.all([
    pipeline(dump.stdout, createGzip({ level: 9 }), cipher, output, {
      end: false,
    }),
    new Promise<void>((resolve, reject) => {
      dump.once("error", reject);
      dump.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`mysqldump exited with ${code}`)),
      );
    }),
  ]);
  output.end(cipher.getAuthTag());
  await new Promise<void>((resolve, reject) => {
    output.once("finish", () => resolve());
    output.once("error", reject);
  });
} catch (error) {
  // A truncated file without its auth tag must not look like a fresh backup.
  output.destroy();
  await unlink(destination).catch(() => undefined);
  throw error;
}

async function retain(directory: string) {
  const cutoff = Date.now() - env.BACKUP_RETENTION_DAYS * 86400000;
  for (const name of await readdir(directory))
    if (/^elite-emporium-.*\.sql\.gz\.enc$/.test(name)) {
      const file = path.join(directory, name);
      if ((await stat(file)).mtimeMs < cutoff) await unlink(file);
    }
}
await retain(env.BACKUP_ROOT);
if (env.BACKUP_OFFSITE_ROOT) {
  await mkdir(env.BACKUP_OFFSITE_ROOT, { recursive: true, mode: 0o700 });
  await copyFile(
    destination,
    path.join(env.BACKUP_OFFSITE_ROOT, path.basename(destination)),
  );
  await retain(env.BACKUP_OFFSITE_ROOT);
}
process.stdout.write(`${destination}\n`);
