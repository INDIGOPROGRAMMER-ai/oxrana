import type { ErrorBody } from '@oxrana/contracts';

/**
 * Запросы к API: тот же адрес, что у приложения (`/api` проксирует Vite в разработке и Caddy на
 * сервере), cookie сессии — httpOnly, JS её не видит. Ошибка API — `ApiError` со структурой
 * `{code, message, field, settingLink}` (CLAUDE.md п. 8).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: Partial<ErrorBody>;
  constructor(status: number, body: Partial<ErrorBody>) {
    super(body.message ?? `Ошибка ${status}. Повторите или сообщите администратору.`);
    this.status = status;
    this.body = body;
  }
  get code(): string | undefined {
    return this.body.code;
  }
  get field(): string | null {
    return this.body.field ?? null;
  }
  get settingLink(): string | null {
    return this.body.settingLink ?? null;
  }
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  /** Файл как есть телом запроса (договор): тип — из самого файла. */
  file?: Blob;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers: options.file
        ? { 'content-type': options.file.type }
        : options.body === undefined
          ? {}
          : { 'content-type': 'application/json' },
      ...(options.file
        ? { body: options.file }
        : options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new ApiError(0, { message: 'Нет связи с сервером. Проверьте сеть и повторите.' });
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) throw new ApiError(res.status, data as Partial<ErrorBody>);
  return data as T;
}

export interface ErrorView {
  readonly message: string;
  readonly field: string | null;
  readonly settingLink: string | null;
  readonly code: string | null;
}

/** Любую ошибку — в вид для экрана; не-API ошибка не раскрывает подробностей. */
export function errorView(error: unknown): ErrorView {
  if (error instanceof ApiError) {
    return {
      message: error.message,
      field: error.field,
      settingLink: error.settingLink,
      code: error.code ?? null,
    };
  }
  if (error instanceof Error && 'body' in error) {
    const body = (error as { body?: Partial<ErrorBody> }).body ?? {};
    return {
      message: error.message,
      field: body.field ?? null,
      settingLink: body.settingLink ?? null,
      code: body.code ?? null,
    };
  }
  return {
    message: 'Что-то пошло не так. Обновите страницу и повторите.',
    field: null,
    settingLink: null,
    code: null,
  };
}

/** Имя файла из `Content-Disposition: attachment; filename*=UTF-8''…`. */
function fileNameOf(header: string | null, fallback: string): string {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header ?? '');
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return fallback;
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header ?? '');
  return plain?.[1] ?? fallback;
}

/**
 * Скачать файл, который отдаёт API (выгрузка списков): запрос с cookie сессии, файл — через
 * временную ссылку. Ошибка сервера приходит в том же виде, что у обычных запросов.
 */
export async function downloadFile(path: string, fallbackName: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, { message: 'Нет связи с сервером. Проверьте сеть и повторите.' });
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as unknown;
    throw new ApiError(res.status, data as Partial<ErrorBody>);
  }
  const name = fileNameOf(res.headers.get('content-disposition'), fallbackName);
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}
