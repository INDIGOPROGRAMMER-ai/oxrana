import { VEHICLE_CATEGORY_PRESETS, type VehicleCategoryPreset } from '@oxrana/contracts';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EditForm,
  Field,
  Input,
  Section,
  SortableList,
  Switch,
  useCreateForm,
  useEditForm,
  useToast,
} from '@oxrana/ui';
import { Pencil, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { api } from '../../lib/api';
import { type CategoryView, useCategories, useMutate, useRefresh } from '../../lib/data';
import { DeleteAction, Empty, GuardPreview, LoadError, RequireSite } from '../common';

/** Типичный набор для логистики: быстрый старт одним кликом. */
const LOGISTICS_SET = ['car', 'light_truck', 'semi', 'truck_5t', 'special'] as const;

function RenameForm({ category, onDone }: { category: CategoryView; onDone: () => void }) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useEditForm<{ name: string }>({
    values: { name: category.name },
    schema: z.strictObject({ name: z.string().trim().min(1, 'Заполните название').max(100) }),
    onPatch: async (patch) => {
      await mutate(`/vehicle-categories/${category.id}`, 'PATCH', patch);
      toast('Название сохранено');
      onDone();
    },
  });
  return (
    <EditForm form={f} submitLabel="Переименовать">
      <Field
        label="Название типа"
        hint="Переименование не меняет историю: прошлые записи сохраняют прежнее название."
        error={f.fieldError('name')}
      >
        <Input {...f.form.register('name')} />
      </Field>
    </EditForm>
  );
}

function CustomTypeForm({ siteId, nextSort }: { siteId: string; nextSort: number }) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useCreateForm<{ name: string; dockEligible: boolean }>({
    schema: z.strictObject({
      siteId: z.uuid(),
      name: z.string().trim().min(1, 'Заполните название').max(100),
      dockEligible: z.boolean(),
      sort: z.int(),
    }),
    initial: { name: '', dockEligible: false },
    toBody: (v) => ({ siteId, name: v.name, dockEligible: v.dockEligible, sort: nextSort }),
    onCreate: async (body) => {
      await mutate('/vehicle-categories', 'POST', body);
      toast('Тип добавлен');
    },
  });
  return (
    <EditForm form={f} mode="create" submitLabel="Добавить тип">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Название своего типа" error={f.fieldError('name')} required>
          <Input {...f.form.register('name')} placeholder="Например, «Рефрижератор»" />
        </Field>
        <div className="flex items-end pb-1">
          <Switch
            label="Обычно едет к доку"
            hint="К такому типу применяется настройка арендатора «грузовые только к докам»."
            {...f.form.register('dockEligible')}
          />
        </div>
      </div>
    </EditForm>
  );
}

/**
 * Карточка «Типы транспорта» (шаг 3, ADR-012): готовый набор включается одним кликом, свои типы,
 * переименование, порядок перетаскиванием. Типа «по умолчанию» нет нигде — ни в формах, ни здесь.
 */
export function CategoriesCard() {
  return <RequireSite>{(site) => <CategoriesBody siteId={site.id} />}</RequireSite>;
}

function CategoriesBody({ siteId }: { siteId: string }) {
  const categories = useCategories(siteId, true);
  const mutate = useMutate();
  const refresh = useRefresh();
  const toast = useToast();
  const [renaming, setRenaming] = useState<CategoryView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  if (categories.error)
    return <LoadError error={categories.error} retry={() => void categories.refetch()} />;
  const items = categories.items ?? [];
  const byPreset = new Map(items.filter((c) => c.presetCode).map((c) => [c.presetCode, c]));
  const nextSort = items.reduce((m, c) => Math.max(m, c.sort), 0) + 1;

  async function run(key: string, fn: () => Promise<unknown>, done: string) {
    setBusy(key);
    setActionError(null);
    try {
      await fn();
      toast(done);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Не удалось выполнить действие');
    } finally {
      setBusy(null);
    }
  }

  const enablePreset = (preset: VehicleCategoryPreset, sort: number) =>
    mutate('/vehicle-categories', 'POST', { siteId, presetCode: preset.code, sort });

  function togglePreset(preset: VehicleCategoryPreset) {
    const existing = byPreset.get(preset.code);
    if (existing) {
      return run(
        preset.code,
        () => mutate(`/vehicle-categories/${existing.id}`, 'PATCH', { enabled: !existing.enabled }),
        existing.enabled ? 'Тип выключен' : 'Тип включён',
      );
    }
    return run(preset.code, () => enablePreset(preset, nextSort), 'Тип включён');
  }

  async function enableLogistics() {
    await run(
      'logistics',
      async () => {
        let sort = nextSort;
        for (const code of LOGISTICS_SET) {
          const preset = VEHICLE_CATEGORY_PRESETS.find((p) => p.code === code);
          if (!preset) continue;
          const existing = byPreset.get(code);
          if (!existing)
            await api('/vehicle-categories', {
              method: 'POST',
              body: { siteId, presetCode: code, sort: sort++ },
            });
          else if (!existing.enabled)
            await api(`/vehicle-categories/${existing.id}`, {
              method: 'PATCH',
              body: { enabled: true },
            });
        }
        await refresh();
      },
      'Набор для логистики включён',
    );
  }

  async function reorder(ids: string[]) {
    await run(
      'reorder',
      async () => {
        const order = new Map(ids.map((id, i) => [id, i + 1]));
        for (const c of items) {
          const sort = order.get(c.id);
          if (sort !== undefined && sort !== c.sort) {
            await api(`/vehicle-categories/${c.id}`, { method: 'PATCH', body: { sort } });
          }
        }
        await refresh();
      },
      'Порядок сохранён',
    );
  }

  const enabled = items.filter((c) => c.enabled);
  return (
    <>
      <Section
        title="Рекомендованный набор"
        description="Включите нужные типы одним кликом. Название потом можно изменить. Выключенный тип не виден в формах, но остаётся в истории."
        actions={
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void enableLogistics()}
          >
            <Wand2 aria-hidden /> Набор для логистики
          </Button>
        }
      >
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {VEHICLE_CATEGORY_PRESETS.map((preset) => {
            const existing = byPreset.get(preset.code);
            const on = existing?.enabled ?? false;
            return (
              <li key={preset.code}>
                <Switch
                  className="rounded-md border bg-card p-2.5"
                  label={existing?.name ?? preset.name}
                  hint={
                    existing && existing.name !== preset.name
                      ? `рекомендованное название: ${preset.name}`
                      : preset.dockEligible
                        ? 'обычно едет к доку'
                        : undefined
                  }
                  checked={on}
                  disabled={busy !== null}
                  onChange={() => void togglePreset(preset)}
                />
              </li>
            );
          })}
        </ul>
        {actionError ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {actionError}
          </p>
        ) : null}
      </Section>

      <Section
        title="Типы объекта и их порядок"
        description="Перетащите за ручку или кнопками «Выше / Ниже»: в таком порядке типы будут в формах и на посту."
      >
        {items.length === 0 ? (
          <Empty
            title="Типов пока нет"
            hint="Включите типы из набора выше или добавьте свой. Без типов нельзя оформить пропуск на машину."
          />
        ) : (
          <SortableList
            label="Типы транспорта"
            disabled={busy !== null}
            onReorder={(ids) => void reorder(ids)}
            items={items.map((c) => ({
              id: c.id,
              content: (
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={
                      c.enabled ? 'font-medium' : 'font-medium text-muted-foreground line-through'
                    }
                  >
                    {c.name}
                  </span>
                  {c.presetCode ? (
                    <Badge tone="outline">из набора</Badge>
                  ) : (
                    <Badge tone="info">свой</Badge>
                  )}
                  {!c.enabled ? <Badge tone="warning">выключен</Badge> : null}
                  {c.dockEligible ? <Badge tone="neutral">к доку</Badge> : null}
                  <span className="ml-auto flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Переименовать: ${c.name}`}
                      onClick={() => setRenaming(c)}
                    >
                      <Pencil aria-hidden />
                    </Button>
                    <DeleteAction
                      collection="vehicle-categories"
                      id={c.id}
                      name={`тип «${c.name}»`}
                      title="Удалить тип транспорта?"
                      {...(c.presetCode
                        ? {
                            disabledReason:
                              'Тип из набора не удаляется — выключите его переключателем выше',
                          }
                        : {})}
                    />
                  </span>
                </div>
              ),
            }))}
          />
        )}
      </Section>

      <Section
        title="Свой тип"
        description="Если в наборе нет нужного — добавьте свой. Типа «по умолчанию» нет: при оформлении пропуска тип выбирают явно."
      >
        <CustomTypeForm siteId={siteId} nextSort={nextSort} />
      </Section>

      {enabled.length > 0 ? (
        <GuardPreview title="Что увидит арендатор в форме пропуска">
          <p>
            Тип транспорта: <strong>{enabled.map((c) => c.name).join(' · ')}</strong>
          </p>
        </GuardPreview>
      ) : null}

      <Dialog open={renaming !== null} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Переименовать тип</DialogTitle>
            <DialogDescription>Например, «малотоннажный» → «Газель».</DialogDescription>
          </DialogHeader>
          {renaming ? <RenameForm category={renaming} onDone={() => setRenaming(null)} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
