import type { PassPresenceSchema } from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import type { Scope } from '../../core/context';
import { labelsOf } from '../../core/labels';
import type { PassRow } from './views';

type Presence = z.infer<typeof PassPresenceSchema>;

/** Кто оформил и кто согласовал: ФИО сотрудника или «Пост <название КПП>», если пропуск оформлен с поста. */
export async function passPeople(
  s: Scope,
  pass: PassRow,
): Promise<{ createdByName: string | null; approvedByName: string | null }> {
  const userName = async (id: string | null): Promise<string | null> => {
    if (!id) return null;
    const [row] = await s.db
      .select({ name: schema.users.fullName })
      .from(schema.users)
      .where(eq(schema.users.id, id));
    return row?.name ?? null;
  };
  let createdByName = await userName(pass.createdBy);
  if (createdByName === null && pass.createdByGateAccountId) {
    const [gate] = await s.db
      .select({ name: schema.gates.name })
      .from(schema.gateAccounts)
      .innerJoin(schema.gates, eq(schema.gates.id, schema.gateAccounts.gateId))
      .where(
        and(
          eq(schema.gateAccounts.organizationId, s.organizationId),
          eq(schema.gateAccounts.id, pass.createdByGateAccountId),
        ),
      );
    createdByName = gate ? `Пост ${gate.name}` : null;
  }
  return { createdByName, approvedByName: await userName(pass.approvedBy) };
}

/** Названия типа транспорта, дока, места назначения и цели визита: пропуск хранит только ссылки. */
export async function passNames(
  s: Scope,
  pass: PassRow,
): Promise<{
  category: string | null;
  dock: string | null;
  zone: string | null;
  purpose: string | null;
}> {
  const [category, dock, zone] = await Promise.all([
    labelsOf(s, 'category', [pass.categoryId]),
    labelsOf(s, 'dock', [pass.dockId]),
    labelsOf(s, 'zone', [pass.destinationZoneId]),
  ]);
  let purpose: string | null = null;
  if (pass.purposeId) {
    const [row] = await s.db
      .select({ name: schema.visitPurposes.name })
      .from(schema.visitPurposes)
      .where(
        and(
          eq(schema.visitPurposes.organizationId, s.organizationId),
          eq(schema.visitPurposes.id, pass.purposeId),
        ),
      );
    purpose = row?.name ?? null;
  }
  return {
    category: pass.categoryId ? (category.get(pass.categoryId) ?? null) : null,
    dock: pass.dockId ? (dock.get(pass.dockId) ?? null) : null,
    zone: pass.destinationZoneId ? (zone.get(pass.destinationZoneId) ?? null) : null,
    purpose,
  };
}

/** «На территории с 14:05 (<КПП>)» / «Последний выезд …» / ещё не въезжал. */
export async function passPresence(s: Scope, passId: string): Promise<Presence> {
  const gateName = async (id: string | null): Promise<string | null> => {
    if (!id) return null;
    const [row] = await s.db
      .select({ name: schema.gates.name })
      .from(schema.gates)
      .where(and(eq(schema.gates.organizationId, s.organizationId), eq(schema.gates.id, id)));
    return row?.name ?? null;
  };
  const [open] = await s.db
    .select()
    .from(schema.visits)
    .where(
      and(
        eq(schema.visits.organizationId, s.organizationId),
        eq(schema.visits.passId, passId),
        isNotNull(schema.visits.timeIn),
        isNull(schema.visits.timeOut),
      ),
    )
    .orderBy(desc(schema.visits.timeIn))
    .limit(1);
  if (open?.timeIn) {
    return {
      state: 'inside',
      since: open.timeIn.toISOString(),
      gate: await gateName(open.gateInId),
    };
  }
  const [last] = await s.db
    .select()
    .from(schema.visits)
    .where(
      and(
        eq(schema.visits.organizationId, s.organizationId),
        eq(schema.visits.passId, passId),
        isNotNull(schema.visits.timeOut),
        isNotNull(schema.visits.gateOutId),
      ),
    )
    .orderBy(desc(schema.visits.timeOut))
    .limit(1);
  if (last?.timeOut) {
    return { state: 'left', at: last.timeOut.toISOString(), gate: await gateName(last.gateOutId) };
  }
  return { state: 'none' };
}
