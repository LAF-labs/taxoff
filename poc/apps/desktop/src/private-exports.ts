import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const EXPORT_PART = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.part$/;

export async function writePrivateExport(file: string, bytes: Uint8Array): Promise<void> {
  const part = path.join(path.dirname(file), `${randomUUID()}.part`);
  const handle = await fs.open(part, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    await fs.rename(part, file);
  } catch (e) {
    // 못 지운 .part는 시작할 때 prepareExistingExports가 지운다. 정리 실패가 실제 오류를 가리지 않게 한다.
    await fs.rm(part, { force: true }).catch(() => {});
    throw e;
  }
}

export async function prepareExistingExports(dir: string, onFailure: (entry: string, error: NodeJS.ErrnoException) => void): Promise<void> {
  const posix = process.platform !== 'win32';
  const visit = async (entry: string): Promise<void> => {
    try {
      const st = await fs.lstat(entry);
      if (entry !== dir && path.dirname(entry) === dir && st.isFile() && EXPORT_PART.test(path.basename(entry))) {
        await fs.unlink(entry);
      } else if (st.isDirectory() && (entry === dir || posix)) {
        if (posix && (st.mode & 0o7777) !== 0o700) {
          await fs.chmod(entry, 0o700).catch((error: NodeJS.ErrnoException) => onFailure(entry, error));
        }
        for (const name of await fs.readdir(entry)) await visit(path.join(entry, name));
      } else if (posix && st.isFile() && (st.mode & 0o7777) !== 0o600) {
        await fs.chmod(entry, 0o600);
      }
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      if (failure.code !== 'ENOENT') onFailure(entry, failure);
    }
  };
  await visit(dir);
}
