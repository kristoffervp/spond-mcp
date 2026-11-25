import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const dataDir = resolve(process.env.SPOND_DATA_DIR || join(projectRoot, '.data'));
export const sessionPath = join(dataDir, 'session.json');
export const apiBase = 'https://api.spond.com/core/v1';

export async function ensurePrivateDataDir() {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
}

// A new file under a random name is renamed into place, so a symlink at the path is replaced instead of written
// through, and a failed write leaves no copy of the tokens behind.
export async function savePrivateJson(path, value) {
  await ensurePrivateDataDir();
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}
