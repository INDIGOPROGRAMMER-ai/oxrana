/**
 * Маршрут (RULES_ENGINE §3, проверка 9): какие КПП разрешены участнику по матрице «тип × КПП».
 * Правила арендатора приоритетнее правил объекта; без правил — любой КПП нужного вида, который
 * пропускает участника. Те же функции использует проверка `routing` и подсказки формы пропуска
 * («Фура → КПП для грузовых»).
 */
import type {
  GateKind,
  GateView,
  Participant,
  PassageDirection,
  RoutingRuleView,
  RuleSet,
} from './types';

export interface RouteSubject {
  readonly tenantId: string;
  readonly participant: Participant;
  readonly categoryId: string | null;
  readonly destinationZoneId: string | null;
}

export function participantAdmitted(gate: GateView, participant: Participant): boolean {
  if (gate.admits === 'vehicles_and_pedestrians') return true;
  return participant === 'vehicle' ? gate.admits === 'vehicles' : gate.admits === 'pedestrians';
}

/** Правила маршрута, применимые к участнику на КПП данного вида и направления. */
export function matchingRoutes(
  rules: RuleSet,
  subject: RouteSubject,
  direction: PassageDirection,
  kind: GateKind,
): RoutingRuleView[] {
  const gateKind = new Map(rules.gates.map((g) => [g.id, g.kind] as const));
  const applies = (r: RoutingRuleView): boolean =>
    r.participant === subject.participant &&
    (r.direction === 'both' || r.direction === direction) &&
    gateKind.get(r.gateId) === kind &&
    (subject.participant === 'pedestrian' ||
      r.categoryId === null ||
      r.categoryId === subject.categoryId) &&
    (r.destinationZoneId === null || r.destinationZoneId === subject.destinationZoneId);
  const tenantRules = rules.routing.filter((r) => r.tenantId === subject.tenantId && applies(r));
  const chosen =
    tenantRules.length > 0
      ? tenantRules
      : rules.routing.filter((r) => r.tenantId === null && applies(r));
  return [...chosen].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

/**
 * Разрешённые КПП для участника: по правилам маршрута (в порядке приоритета), а без правил — все
 * КПП нужного вида, которые его пропускают. КПП, не пропускающий участника, не возвращается никогда.
 */
export function routeGates(
  rules: RuleSet,
  subject: RouteSubject,
  direction: PassageDirection = 'in',
  kind: GateKind = 'perimeter',
): string[] {
  const admitted = rules.gates.filter(
    (g) => g.kind === kind && participantAdmitted(g, subject.participant),
  );
  const routes = matchingRoutes(rules, subject, direction, kind);
  if (routes.length === 0) return admitted.map((g) => g.id);
  const allowed = new Set(admitted.map((g) => g.id));
  return [...new Set(routes.map((r) => r.gateId))].filter((id) => allowed.has(id));
}
