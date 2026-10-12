import { Section } from '@oxrana/ui';
import type { ComponentType } from 'react';
import { CategoriesCard } from './categories-card';
import { DevicesCard } from './devices-card';
import { DocksCard } from './docks-card';
import { ExceptionsCard } from './exceptions-card';
import { GatesCard } from './gates-card';
import { LimitsStep } from './limits-step';
import { PedestrianRulesStep } from './pedestrian-rules-card';
import { PoliciesCard } from './policies-card';
import { PeopleCard } from './roles-card';
import { RoutingCard } from './routing-card';
import { SiteCard } from './site-card';
import { SummaryCard } from './summary-card';
import { TenantsStep } from './tenants-card';

/** Шаг 8: политики, исключения и правила пешеходов — три карточки на одном шаге. */
function PoliciesStep() {
  return (
    <>
      <PoliciesCard />
      <Section
        title="Исключения"
        description="Особые случаи: служебная машина без досмотра, арендатор круглосуточно. Каждое — с основанием."
      >
        <ExceptionsCard />
      </Section>
      <Section
        title="Правила для пешеходов"
        description="Нужен ли документ и сопровождение — по арендатору. Охранник увидит это одной строкой."
      >
        <PedestrianRulesStep />
      </Section>
    </>
  );
}

/** Карточка каждого шага мастера (ключ — `slug` из `lib/setup.ts`). */
export const STEP_CARDS: Record<string, ComponentType> = {
  site: SiteCard,
  gates: GatesCard,
  types: CategoriesCard,
  routes: RoutingCard,
  docks: DocksCard,
  tenants: TenantsStep,
  limits: LimitsStep,
  policies: PoliciesStep,
  people: PeopleCard,
  devices: DevicesCard,
  check: SummaryCard,
};
