import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, schema } from '../src';
import { createOrgFixture, type OrgFixture, pgErrorOf, vehiclePass } from './fixtures';

/**
 * Невозможные состояния запрещает БД (DATA_MODEL §5 п. 15): дубли действующих пропусков у одного
 * арендатора (10_ §4, Z-14) и док у двух арендаторов сразу (10_ §1).
 */
const pool = createPool({ connectionString: process.env.DATABASE_ADMIN_URL ?? '', max: 2 });
const db = createDb(pool);
afterAll(() => pool.end());

let f: OrgFixture;
let otherTenantId: string;
let plateSeq = 0;
/** Каждому тесту — свой номер: тесты файла не мешают друг другу. */
const nextPlate = () => `A${String(++plateSeq).padStart(3, '0')}BC174`;

const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  f = await createOrgFixture(db, 'excl');
  const [other] = await db
    .insert(schema.tenants)
    .values({
      organizationId: f.organizationId,
      siteId: f.siteId,
      legalName: 'Второй арендатор',
      shortName: 'Второй',
    })
    .returning();
  otherTenantId = other?.id ?? '';
});

const DUPLICATE = { code: '23P01', constraint: 'passes_no_duplicate' };
const DOCK_TAKEN = { code: '23P01', constraint: 'tenant_dock_assignments_no_overlap' };

describe('дубли пропусков отсекаются (exclusion)', () => {
  it('пересекающийся одобренный пропуск на тот же номер у того же арендатора — отказ', async () => {
    const plateNorm = nextPlate();
    await db.insert(schema.passes).values(
      vehiclePass(f, {
        plateNorm,
        validFrom: at('2026-10-01T00:00:00Z'),
        validTo: at('2026-10-10T00:00:00Z'),
      }),
    );
    expect(
      await pgErrorOf(
        db.insert(schema.passes).values(
          vehiclePass(f, {
            plateNorm,
            validFrom: at('2026-10-05T00:00:00Z'),
            validTo: at('2026-10-15T00:00:00Z'),
          }),
        ),
      ),
    ).toMatchObject(DUPLICATE);
  });

  it('встык — не пересечение: конец одного = начало другого', async () => {
    const plateNorm = nextPlate();
    await db.insert(schema.passes).values([
      vehiclePass(f, {
        plateNorm,
        validFrom: at('2026-10-01T00:00:00Z'),
        validTo: at('2026-10-10T00:00:00Z'),
      }),
      vehiclePass(f, {
        plateNorm,
        validFrom: at('2026-10-10T00:00:00Z'),
        validTo: at('2026-10-20T00:00:00Z'),
      }),
    ]);
  });

  it('та же машина у другого арендатора — не дубль', async () => {
    const plateNorm = nextPlate();
    const period = { validFrom: at('2026-10-01T00:00:00Z'), validTo: at('2026-10-10T00:00:00Z') };
    await db.insert(schema.passes).values(vehiclePass(f, { plateNorm, ...period }));
    await db
      .insert(schema.passes)
      .values(vehiclePass(f, { plateNorm, ...period, tenantId: otherTenantId }));
  });

  it('неодобренные и отменённые не мешают', async () => {
    const plateNorm = nextPlate();
    const period = { validFrom: at('2026-10-01T00:00:00Z'), validTo: at('2026-10-10T00:00:00Z') };
    await db
      .insert(schema.passes)
      .values([
        vehiclePass(f, { plateNorm, ...period, status: 'approved' }),
        vehiclePass(f, { plateNorm, ...period, status: 'pending_approval' }),
        vehiclePass(f, { plateNorm, ...period, status: 'cancelled' }),
        vehiclePass(f, { plateNorm, ...period, status: 'expired' }),
      ]);
  });

  it('постоянный пропуск без срока перекрывает всё будущее (Z-14)', async () => {
    const plateNorm = nextPlate();
    await db.insert(schema.passes).values(
      vehiclePass(f, {
        plateNorm,
        passType: 'permanent',
        validFrom: at('2026-11-01T00:00:00Z'),
        validTo: null,
      }),
    );
    expect(
      await pgErrorOf(
        db.insert(schema.passes).values(
          vehiclePass(f, {
            plateNorm,
            passType: 'single',
            validFrom: at('2030-01-01T08:00:00Z'),
            validTo: at('2030-01-02T08:00:00Z'),
          }),
        ),
      ),
    ).toMatchObject(DUPLICATE);
  });

  it('одобрение второго пересекающегося пропуска тоже отсекается', async () => {
    const plateNorm = nextPlate();
    const period = { validFrom: at('2026-10-01T00:00:00Z'), validTo: at('2026-10-10T00:00:00Z') };
    await db.insert(schema.passes).values(vehiclePass(f, { plateNorm, ...period }));
    const [pending] = await db
      .insert(schema.passes)
      .values(vehiclePass(f, { plateNorm, ...period, status: 'pending_approval' }))
      .returning();
    expect(
      await pgErrorOf(
        db
          .update(schema.passes)
          .set({ status: 'approved' })
          .where(eq(schema.passes.id, pending?.id ?? '')),
      ),
    ).toMatchObject(DUPLICATE);
  });
});

describe('док не бывает у двух арендаторов сразу (exclusion)', () => {
  async function newDock(number: string): Promise<string> {
    const [dock] = await db
      .insert(schema.docks)
      .values({ organizationId: f.organizationId, siteId: f.siteId, number })
      .returning();
    return dock?.id ?? '';
  }
  const assign = (dockId: string, tenantId: string, validFrom: string, validTo: string | null) =>
    db
      .insert(schema.tenantDockAssignments)
      .values({ organizationId: f.organizationId, tenantId, dockId, validFrom, validTo });

  it('бессрочное назначение и пересекающееся другому арендатору — отказ', async () => {
    const dockId = await newDock('1');
    await assign(dockId, f.tenantId, '2026-01-01', null);
    expect(
      await pgErrorOf(assign(dockId, otherTenantId, '2026-06-01', '2026-06-30')),
    ).toMatchObject(DOCK_TAKEN);
  });

  it('границы включительные: последний день одного не может быть первым днём другого', async () => {
    const dockId = await newDock('2');
    await assign(dockId, f.tenantId, '2026-01-01', '2026-05-31');
    expect(await pgErrorOf(assign(dockId, otherTenantId, '2026-05-31', null))).toMatchObject(
      DOCK_TAKEN,
    );
    await assign(dockId, otherTenantId, '2026-06-01', null);
  });
});
