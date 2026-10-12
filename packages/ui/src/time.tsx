import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { createContext, type ReactNode, useContext } from 'react';

/**
 * Время в интерфейсе (ADR-009): всегда в поясе объекта и с подписью пояса («14:32 (Челябинск, UTC+5)»);
 * пояс браузера и сервера не читается нигде. Если пользователь включил «моё время», ниже мелкой
 * строкой — время в его поясе; заменить время объекта своим нельзя.
 */
export interface SiteTimeInfo {
  readonly timezone: string;
  /** Готовая подпись пояса с сервера: «Челябинск, UTC+5». */
  readonly label: string;
}
export interface OwnTimeInfo {
  readonly timezone: string;
  readonly label: string;
}

interface TimeContextValue {
  readonly site: SiteTimeInfo | null;
  readonly own: OwnTimeInfo | null;
}
const TimeContext = createContext<TimeContextValue>({ site: null, own: null });

export function SiteTimeProvider({
  site,
  own = null,
  children,
}: {
  site: SiteTimeInfo | null;
  own?: OwnTimeInfo | null;
  children: ReactNode;
}) {
  return <TimeContext.Provider value={{ site, own }}>{children}</TimeContext.Provider>;
}

export function useSiteTime(): TimeContextValue {
  return useContext(TimeContext);
}

/** «12.10.2026 14:30» в указанном поясе. */
export function formatInZone(iso: string, timezone: string): string {
  return format(new TZDate(iso, timezone), 'dd.MM.yyyy HH:mm');
}

/** Местная дата `ГГГГ-ММ-ДД` (договоры, назначения) — как «12.10.2026», без пересчёта поясов. */
export function formatLocalDate(date: string): string {
  const [y, m, d] = date.split('-');
  return y && m && d ? `${d}.${m}.${y}` : date;
}

/**
 * Мгновение из локальных полей **в поясе объекта** (ADR-009 п. 3): «2026-03-10» + «14:00» в
 * Asia/Yekaterinburg → ISO в UTC. Пояс браузера не участвует.
 */
export function localToInstant(date: string, time: string, timezone: string): string {
  const [y = 0, mo = 1, d = 1] = date.split('-').map(Number);
  const [h = 0, mi = 0] = time.split(':').map(Number);
  return new TZDate(y, mo - 1, d, h, mi, 0, timezone).toISOString();
}

/** Время объекта с подписью пояса и, если включено, «у вас …» второй строкой. */
export function SiteTime({ value }: { value: string | null | undefined }) {
  const { site, own } = useSiteTime();
  if (!value) return <span className="text-muted-foreground">—</span>;
  if (!site) {
    return <span className="text-muted-foreground">пояс объекта не загружен</span>;
  }
  return (
    <span className="inline-flex flex-col leading-tight">
      <time dateTime={value}>
        {formatInZone(value, site.timezone)}{' '}
        <span className="text-muted-foreground">({site.label})</span>
      </time>
      {own && own.timezone !== site.timezone ? (
        <span className="text-xs text-muted-foreground">
          у вас {format(new TZDate(value, own.timezone), 'HH:mm')}, {own.label}
        </span>
      ) : null}
    </span>
  );
}
