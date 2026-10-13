import type { SandboxCheck } from '@oxrana/contracts';
import { capacityOf, participantAdmitted, routeGates } from '@oxrana/engine';
import { runSandbox, type SandboxData } from './engine';

/**
 * Примеры для шага «Проверка» мастера: 3–5 прогонов движка по настроенным данным объекта —
 * «фура арендатора не на своём КПП → синий, все места заняты → жёлтый». Берутся первые подходящие записи;
 * чего не хватает — в `note`.
 */
export interface ExampleItem {
  key: string;
  title: string;
  request: SandboxCheck;
}

const MAX_EXAMPLES = 5;

export function buildExamples(data: SandboxData, nowMs: number) {
  const { rules } = data;
  const items: ExampleItem[] = [];
  const notes: string[] = [];
  const active = rules.tenants.filter((t) => !t.isOperator && t.status === 'active');
  const quotaOf = (tenantId: string) =>
    rules.quotas.find(
      (q) =>
        q.tenantId === tenantId &&
        q.participant === 'vehicle' &&
        q.categoryIds.length > 0 &&
        q.validFrom <= nowMs &&
        (q.validTo === null || q.validTo > nowMs) &&
        capacityOf(q, rules.docks) > 0,
    );
  const tenant = active.find((t) => quotaOf(t.id));
  const quota = tenant ? quotaOf(tenant.id) : undefined;
  const category = quota
    ? rules.categories.find((c) => quota.categoryIds.includes(c.id))
    : undefined;

  if (tenant && quota && category) {
    const allowed = routeGates(
      rules,
      {
        tenantId: tenant.id,
        participant: 'vehicle',
        categoryId: category.id,
        destinationZoneId: null,
      },
      'in',
    );
    const gate = rules.gates.find((g) => g.id === allowed[0]);
    if (gate) {
      const dock = category.dockEligible
        ? rules.docks.find((d) => d.tenantId === tenant.id)
        : undefined;
      const base: SandboxCheck = {
        tenantId: tenant.id,
        passType: 'multi',
        participant: 'vehicle',
        categoryId: category.id,
        gateId: gate.id,
        direction: 'in',
        ...(dock ? { dockId: dock.id } : {}),
      };
      items.push({
        key: 'allow',
        title: `${tenant.name}: ${category.name} на ${gate.name}`,
        request: base,
      });
      items.push({
        key: 'full',
        title: `${tenant.name}: все ${capacityOf(quota, rules.docks)} мест «${quota.name}» заняты`,
        request: { ...base, quotaFull: true },
      });
      const other = rules.gates.find(
        (g) =>
          g.kind === 'perimeter' && participantAdmitted(g, 'vehicle') && !allowed.includes(g.id),
      );
      if (other) {
        items.push({
          key: 'wrong_gate',
          title: `${tenant.name}: ${category.name} на ${other.name} (не по маршруту)`,
          request: { ...base, gateId: other.id },
        });
      }
      const listed = rules.blacklist.find(
        (b) => b.plateNorm && (b.validTo === null || b.validTo > nowMs),
      );
      if (listed?.plateNorm) {
        items.push({
          key: 'blacklist',
          title: `Номер ${listed.plateNorm} из чёрного списка`,
          request: { ...base, plate: listed.plateNorm },
        });
      }
    }
  } else if (active.length === 0) {
    notes.push('Нет действующих арендаторов (шаг 6).');
  } else {
    notes.push(
      'Ни у одного арендатора нет лимита на машины (шаг 7) — примеры с въездом машин не из чего собрать.',
    );
  }

  const blocked = rules.tenants.find(
    (t) => t.status === 'blocked_entry' || t.status === 'blocked_full',
  );
  if (blocked) {
    const cat = rules.categories[0];
    const gate = rules.gates.find(
      (g) => g.kind === 'perimeter' && participantAdmitted(g, 'vehicle'),
    );
    if (cat && gate) {
      items.push({
        key: 'blocked',
        title: `${blocked.name} заблокирован: въезд ${cat.name} на ${gate.name}`,
        request: {
          tenantId: blocked.id,
          passType: 'multi',
          participant: 'vehicle',
          categoryId: cat.id,
          gateId: gate.id,
          direction: 'in',
        },
      });
    }
  }

  const walk = rules.gates.find((g) => participantAdmitted(g, 'pedestrian'));
  const walker = tenant ?? active[0];
  if (walker && walk) {
    items.push({
      key: 'pedestrian',
      title: `${walker.name}: пешеход на ${walk.name}`,
      request: {
        tenantId: walker.id,
        passType: 'single',
        participant: 'pedestrian',
        gateId: walk.id,
        direction: 'in',
        personName: 'Тестовый Пешеход',
      },
    });
  }

  const picked = items.slice(0, MAX_EXAMPLES).map((item) => {
    const out = runSandbox(data, item.request, nowMs);
    return {
      key: item.key,
      title: item.title,
      request: item.request,
      code: out.verdict.code,
      color: out.verdict.color,
      headline: out.verdict.headline,
    };
  });
  return {
    items: picked,
    note:
      picked.length >= 3
        ? null
        : notes.join(' ') ||
          'Настройте КПП, типы, арендаторов и лимиты — и здесь появятся примеры.',
  };
}
