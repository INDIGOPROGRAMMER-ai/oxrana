import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

/**
 * Хранилище файлов (Q-63, ADR-021): договоры сейчас, фото с камер позже (Q-12). Ключ —
 * `<organization_id>/<id>`: файл принадлежит организации, имя на диске не зависит от имени, которое
 * дал пользователь. Реализация — локальный том; S3 подключается другой реализацией интерфейса.
 */
export interface FileStore {
  put(key: string, data: Buffer): Promise<void>;
  /** Поток файла; `null` — файла нет (удалён с диска или не записан). */
  read(key: string): Promise<{ stream: Readable; size: number } | null>;
  remove(key: string): Promise<void>;
}

const KEY_RE =
  /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function fileKey(organizationId: string, fileId: string): string {
  return `${organizationId}/${fileId}`;
}

/** Локальный том: каталог `dir`, права 600 на файлы. Ключ проверяется — выйти из каталога нельзя. */
export class LocalFileStore implements FileStore {
  private readonly root: string;

  constructor(dir: string) {
    this.root = resolve(dir);
  }

  private pathOf(key: string): string {
    if (!KEY_RE.test(key)) throw new Error(`Недопустимый ключ файла: ${key}`);
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root + sep)) throw new Error(`Ключ вне каталога файлов: ${key}`);
    return path;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Сначала во временный файл, затем переименование: недописанный файл не виден как готовый.
    const temp = `${path}.part`;
    await writeFile(temp, data, { mode: 0o600 });
    await rename(temp, path);
  }

  async read(key: string): Promise<{ stream: Readable; size: number } | null> {
    const path = this.pathOf(key);
    try {
      const info = await stat(path);
      return { stream: createReadStream(path), size: info.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }
}
