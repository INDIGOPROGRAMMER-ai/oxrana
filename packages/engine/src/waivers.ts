/**
 * Исключения (RULES_ENGINE §5): какие проверки сняты для пропуска и какими исключениями.
 */
import type { ExceptionView, Instant, PassView, Waiver } from './types';

export interface Waivers {
  /** Снятые проверки. */
  readonly waived: ReadonlySet<Waiver>;
  /** Исключения, которые совпали с пропуском, в порядке списка правил. */
  readonly applied: readonly ExceptionView[];
  /** Какое исключение сняло проверку (первое совпавшее). */
  readonly byWaiver: ReadonlyMap<Waiver, ExceptionView>;
}

function matches(exception: ExceptionView, pass: PassView): boolean {
  if (exception.tenantId !== null && exception.tenantId !== pass.tenantId) return false;
  const m = exception.match;
  if ('plates' in m) return pass.plateNorm !== null && m.plates.includes(pass.plateNorm);
  if ('categoryIds' in m)
    return pass.categoryId !== null && m.categoryIds.includes(pass.categoryId);
  if ('passIds' in m) return m.passIds.includes(pass.id);
  return exception.tenantId === pass.tenantId;
}

export function collectWaivers(
  pass: PassView,
  exceptions: readonly ExceptionView[],
  now: Instant,
): Waivers {
  const waived = new Set<Waiver>();
  const applied: ExceptionView[] = [];
  const byWaiver = new Map<Waiver, ExceptionView>();
  for (const exception of exceptions) {
    if (exception.validFrom > now || (exception.validTo !== null && exception.validTo <= now)) {
      continue;
    }
    if (!matches(exception, pass)) continue;
    applied.push(exception);
    for (const waiver of exception.waives) {
      waived.add(waiver);
      if (!byWaiver.has(waiver)) byWaiver.set(waiver, exception);
    }
  }
  return { waived, applied, byWaiver };
}
