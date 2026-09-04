import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve('.local');
await mkdir(output, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
await writeFile(path.join(output, 'jwt-private.pem'), privateKey, { mode: 0o600 });
await writeFile(path.join(output, 'jwt-public.pem'), publicKey, { mode: 0o644 });
process.stdout.write(`Generated development JWT keys in ${output}\n`);
