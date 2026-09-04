import { ensureMediaDirectories } from '../src/modules/media/media.storage.js';

await ensureMediaDirectories();
process.stdout.write('Media directories are ready.\n');
