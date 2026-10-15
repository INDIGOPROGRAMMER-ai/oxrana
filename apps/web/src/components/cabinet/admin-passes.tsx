import { Field, SegmentedChoice, Select } from '@oxrana/ui';
import { useState } from 'react';
import { InsideList } from '../inside-list';
import { SiteCabinetProvider, useCabinet } from './cabinet-context';
import { PassList } from './pass-list';

export type PassesView = 'all' | 'inside';

/**
 * Страница «Пропуска» админки (7b.2): тот же список, что в кабинете арендатора (поиск, фильтры,
 * «Показать ещё», «Найдено N», выгрузка), но по всем арендаторам объекта — с фильтром и названием
 * арендатора; переключатель «Все пропуска / Сейчас на территории» по всему объекту. Компоненты
 * кабинета не копируются: им подаётся контекст всего объекта (`SiteCabinetProvider`).
 */
export function AdminPasses({
  siteId,
  view,
  onView,
}: {
  siteId: string;
  view: PassesView;
  onView: (view: PassesView) => void;
}) {
  return (
    <SiteCabinetProvider siteId={siteId}>
      <div className="space-y-4">
        <SegmentedChoice
          aria-label="Что показать"
          value={view}
          onChange={onView}
          options={[
            { value: 'all', label: 'Все пропуска' },
            { value: 'inside', label: 'Сейчас на территории' },
          ]}
        />
        {view === 'all' ? <PassList /> : <InsideAll siteId={siteId} />}
      </div>
    </SiteCabinetProvider>
  );
}

/** «Сейчас на территории» по всему объекту; арендатора можно выбрать. */
function InsideAll({ siteId }: { siteId: string }) {
  const { ctx, allTenants, serverNow } = useCabinet();
  const [tenantId, setTenantId] = useState('');
  if (!ctx) return null;
  return (
    <div className="space-y-4">
      <Field label="Арендатор" className="max-w-xs">
        <Select
          aria-label="Арендатор на территории"
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
        >
          <option value="">Все арендаторы</option>
          {(allTenants ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>
      <InsideList
        siteId={siteId}
        tenantId={tenantId || undefined}
        timezone={ctx.site.timezone}
        serverNow={serverNow}
        showTenant
      />
    </div>
  );
}
