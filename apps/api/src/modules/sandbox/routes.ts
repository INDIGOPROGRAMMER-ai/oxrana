import {
  QuotaWhatIfResultSchema,
  QuotaWhatIfSchema,
  SandboxCheckSchema,
  SandboxExamplesSchema,
  SandboxResultSchema,
  SiteParamsSchema,
} from '@oxrana/contracts';
import { capacityOf, countOccupancy } from '@oxrana/engine';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ctxOf } from '../../core/context';
import { loadSite } from '../../core/loaders';
import { AppError } from '../../errors';
import { verdictView } from '../gate/actions';
import { loadSandboxData, personNames, runSandbox } from './engine';
import { buildExamples } from './examples';

/**
 * Песочница правил (этап 6b): «что скажет охраннику система» без записи чего-либо, и «что будет,
 * если» — как изменение лимита отразится на тех, кто сейчас внутри. Право `sandbox.use`.
 */
export function registerSandboxModule(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['sandbox'];

  typed.post(
    '/sites/:siteId/sandbox/check',
    {
      config: { permission: 'sandbox.use' },
      schema: {
        tags,
        summary: 'Песочница: вердикт движка для воображаемого пропуска (с причинами и trace)',
        params: SiteParamsSchema,
        body: SandboxCheckSchema,
        response: { 200: SandboxResultSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const site = await loadSite(s, request.params.siteId);
        const data = await loadSandboxData(s, site);
        const out = runSandbox(data, request.body, ctx.now());
        return { verdict: verdictView(out.verdict), subject: out.subject, assumptions: out.assumptions };
      });
    },
  );

  typed.get(
    '/sites/:siteId/sandbox/examples',
    {
      config: { permission: 'sandbox.use' },
      schema: {
        tags,
        summary: 'Песочница: 3–5 примеров из настроенных данных объекта (для шага «Проверка» мастера)',
        params: SiteParamsSchema,
        response: { 200: SandboxExamplesSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const site = await loadSite(s, request.params.siteId);
        const data = await loadSandboxData(s, site);
        return buildExamples(data, ctx.now());
      });
    },
  );

  typed.post(
    '/sites/:siteId/sandbox/quota-what-if',
    {
      config: { permission: 'sandbox.use' },
      schema: {
        tags,
        summary: 'Что будет, если изменить лимит: сколько сейчас внутри и кто окажется сверх',
        params: SiteParamsSchema,
        body: QuotaWhatIfSchema,
        response: { 200: QuotaWhatIfResultSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const { quotaId, capacity, enforcement } = request.body;
      return ctx.tx(async (s) => {
        const site = await loadSite(s, request.params.siteId);
        const data = await loadSandboxData(s, site);
        const { rules } = data;
        const quota = rules.quotas.find((q) => q.id === quotaId);
        if (!quota) {
          throw new AppError('not_found', {
            message: 'Лимит не найден на этом объекте. Обновите страницу.',
          });
        }
        const counted = data.openVisits
          .filter((v) => countOccupancy([v], quota) === 1)
          .sort((a, b) => (a.timeIn ?? 0) - (b.timeIn ?? 0) || a.id.localeCompare(b.id));
        const currentCapacity = capacityOf(quota, rules.docks);
        const proposedCapacity = capacity ?? currentCapacity;
        const proposedEnforcement = enforcement ?? quota.enforcement;
        const overBy = Math.max(0, counted.length - proposedCapacity);
        const names = await personNames(
          s,
          counted.flatMap((v) => (v.passId ? [v.passId] : [])),
        );
        const categoryName = (id: string | null) =>
          rules.categories.find((c) => c.id === id)?.name ?? null;
        const tenantName = rules.tenants.find((t) => t.id === quota.tenantId)?.name ?? '';
        const inside = counted.map((v, index) => ({
          visitId: v.id,
          plate: v.plateNorm,
          personName: v.passId ? (names.get(v.passId) ?? null) : null,
          categoryName: categoryName(v.categoryId),
          timeIn: v.timeIn === null ? null : new Date(v.timeIn).toISOString(),
          over: index >= proposedCapacity,
        }));
        const same = capacity === undefined || capacity === currentCapacity;
        const head = same
          ? `Лимит «${quota.name}» (${tenantName}): сейчас внутри ${counted.length} из ${currentCapacity}.`
          : `Лимит «${quota.name}» (${tenantName}): было ${currentCapacity}, станет ${proposedCapacity}; сейчас внутри ${counted.length}.`;
        const tail =
          overBy === 0
            ? 'Никто не окажется сверх лимита.'
            : proposedEnforcement === 'hard'
              ? `Сверх лимита окажется ${overBy}: они остаются на территории, но новые въезды арендатора будут ждать, пока число не станет меньше ${proposedCapacity}.`
              : `Сверх лимита окажется ${overBy}: это попадёт в сверхлимит (${proposedEnforcement === 'soft' ? 'с начислением' : 'с предупреждением'}).`;
        return {
          quotaId: quota.id,
          quotaName: quota.name,
          tenantName,
          occupied: counted.length,
          currentCapacity,
          proposedCapacity,
          currentEnforcement: quota.enforcement,
          proposedEnforcement,
          overBy,
          inside,
          summary: `${head} ${tail}`,
        };
      });
    },
  );
}
