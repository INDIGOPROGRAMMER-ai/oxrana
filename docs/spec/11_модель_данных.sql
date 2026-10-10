-- Черновая схема PostgreSQL для своей платформы пропускного режима.
-- Принципы: UTC-время (timestamptz), мягкое удаление, снимки названий в журнальных таблицах,
-- квоты и маршруты — отдельные правила, не связанные с «адресами».

create extension if not exists pgcrypto;  -- gen_random_uuid
create extension if not exists pg_trgm;   -- поиск по подстроке номера

-- ========== Организация и объект ==========
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table sites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name text not null,                       -- «ЛЦ «Радонежский»»
  address text,
  geo point,
  timezone text not null,                   -- 'Asia/Yekaterinburg'
  working_hours jsonb,                      -- {"mon":["08:00","20:00"],...} ; null = круглосуточно
  settings jsonb not null default '{}',     -- допуски окон, сроки пропусков, хранение
  deleted_at timestamptz
);

create table zones (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id),
  name text not null,                       -- «Основной склад», «Стр. 5», «Парковка у столовой»
  kind text not null check (kind in ('building','yard','parking','dock_area','other')),
  deleted_at timestamptz
);

create table gates (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id),
  name text not null,                       -- «КПП-1»
  direction text not null default 'both' check (direction in ('in','out','both')),
  working_hours jsonb,
  deleted_at timestamptz
);

create table docks (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id),
  zone_id uuid references zones(id),
  number text not null,                     -- «19», «71»
  kind text not null default 'leveller' check (kind in ('leveller','ground_gate','other')),
  size text,
  unique (site_id, number)
);

create table parking_areas (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id),
  zone_id uuid references zones(id),
  name text not null,
  spaces int                                 -- null = без разметки
);

-- ========== Справочники ==========
create table vehicle_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  site_id uuid references sites(id),        -- null = на уровне организации; иначе переопределение
  code text not null,                       -- 'car','light_truck','truck_10t','semi','special','bus'
  name text not null,                       -- «малотоннажный»
  default_group text,                       -- 'cars' | 'trucks'
  sort int not null default 100,
  unique (organization_id, site_id, code)
);

create table category_groups (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id),
  tenant_id uuid,                           -- null = общая группа объекта; иначе своя у арендатора
  name text not null                        -- «Грузовые», «Грузовые до 4,5 т»
);
create table category_group_members (
  group_id uuid not null references category_groups(id),
  category_id uuid not null references vehicle_categories(id),
  primary key (group_id, category_id)
);

create table visit_purposes (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id),
  name text not null,                       -- «Разгрузка»
  max_stay_minutes int                      -- норматив; null = нет
);

-- ========== Арендаторы и договоры ==========
create table tenants (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id),
  legal_name text not null,
  short_name text not null,                 -- для экрана охраны: «ДНС»
  inn text,
  status text not null default 'active' check (status in ('active','blocked_new_passes','blocked_entry','archived')),
  emergency_phone text,
  default_category_id uuid references vehicle_categories(id),
  deleted_at timestamptz
);
alter table category_groups add constraint category_groups_tenant_fk foreign key (tenant_id) references tenants(id);

create table contracts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  number text, signed_on date, valid_from date, valid_to date,
  file_url text,
  notes text
);

create table contract_clauses (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references contracts(id),
  ref text not null,                        -- «п. 2.1», «прил. 2»
  summary text not null                     -- «30 легковых мест в составе арендной платы»
);

create table tenant_dock_assignments (
  tenant_id uuid not null references tenants(id),
  dock_id uuid not null references docks(id),
  valid_from date not null, valid_to date,
  basis_clause_id uuid references contract_clauses(id),
  primary key (tenant_id, dock_id, valid_from)
);

create table tenant_parking_assignments (
  tenant_id uuid not null references tenants(id),
  parking_area_id uuid not null references parking_areas(id),
  spaces int not null,
  valid_from date not null, valid_to date,
  basis_clause_id uuid references contract_clauses(id),
  primary key (tenant_id, parking_area_id, valid_from)
);

-- ========== Правила ==========
create table quotas (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  category_group_id uuid references category_groups(id),
  participant text not null default 'vehicle' check (participant in ('vehicle','pedestrian')),
  capacity int not null,                    -- 0 = не предусмотрено
  capacity_from_docks boolean not null default false,
  counting text not null default 'on_site' check (counting in ('on_site','active_passes','per_day')),
  enforcement text not null default 'hard' check (enforcement in ('hard','soft','warn')),
  overage_tariff_rub numeric(10,2),         -- ₽ за единицу в сутки сверх лимита
  overage_cap int,
  schedule jsonb,
  basis_clause_id uuid references contract_clauses(id),
  valid_from timestamptz not null default now(), valid_to timestamptz
);

create table routing_rules (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id),
  tenant_id uuid references tenants(id),    -- null = общее правило объекта
  participant text not null check (participant in ('vehicle','pedestrian')),
  category_id uuid references vehicle_categories(id), -- null для пешехода
  gate_id uuid not null references gates(id),
  direction text not null default 'in' check (direction in ('in','out','both')),
  priority int not null default 100
);

create table time_window_policies (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id),
  tenant_id uuid references tenants(id),
  category_group_id uuid references category_groups(id),
  window_required boolean not null default false,
  early_tolerance_min int not null default 0,
  late_tolerance_min int,                    -- null = до конца пропуска
  on_violation text not null default 'hard' check (on_violation in ('hard','warn'))
);

create table exceptions (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id),
  tenant_id uuid references tenants(id),
  name text not null,                        -- «Служебный автобус ДНС»
  match jsonb not null,                      -- {"plates":[...]} | {"category":"bus"} | {"tenant":true}
  waives text[] not null,                    -- {'inspection','quota','time_window','working_hours','routing'}
  basis text,
  valid_from timestamptz not null default now(), valid_to timestamptz,
  created_by uuid
);

create table approval_policies (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id),
  creator_role text not null,               -- 'tenant','guard','admin'
  pass_type text not null check (pass_type in ('single','multi','permanent')),
  mode text not null check (mode in ('allow','on_request','deny')),
  approver_role text,                       -- 'site_approver'
  comment_required boolean not null default false
);

create table blacklist (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  site_id uuid references sites(id),        -- null = на всю организацию
  plate_norm text, person_name text,
  reason text not null,
  valid_to timestamptz
);

-- ========== Пропуска и визиты ==========
create table passes (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id),
  tenant_id uuid not null references tenants(id),
  pass_type text not null check (pass_type in ('single','multi','permanent')),
  participant text not null check (participant in ('vehicle','pedestrian')),
  plate_raw text, plate_norm text, plate_country text,
  category_id uuid references vehicle_categories(id),
  brand text,
  person_name text,
  driver_name text, driver_phone text,
  purpose_id uuid references visit_purposes(id),
  destination jsonb,                        -- {"dock":"19"} | {"zone":...}
  valid_from timestamptz, valid_to timestamptz,
  window_from timestamptz, window_to timestamptz,
  status text not null check (status in ('draft','pending_approval','approved','rejected','cancelled','expired','used')),
  comment text,
  created_by uuid not null, created_via text not null, -- 'web','pwa','bot','api','gate'
  batch_id uuid,
  approved_by uuid, approved_at timestamptz, approval_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index passes_plate_idx on passes using gin (plate_norm gin_trgm_ops);
create index passes_site_status_idx on passes (site_id, status);

create table visits (
  id uuid primary key default gen_random_uuid(),
  pass_id uuid references passes(id),
  site_id uuid not null references sites(id),
  tenant_id uuid not null references tenants(id),
  -- снимок на момент въезда
  snapshot jsonb not null,                  -- {"tenant":"ДНС","category":"фура","plate":"H524MC136","gate":"КПП-2"}
  category_id uuid references vehicle_categories(id),
  gate_in_id uuid references gates(id), time_in timestamptz, guard_in uuid,
  gate_out_id uuid references gates(id), time_out timestamptz, guard_out uuid,
  method_in text, method_out text,          -- 'button','qr','lpr'
  overage boolean not null default false,
  exception_id uuid references exceptions(id),
  flags text[] not null default '{}'        -- {'no_checkin','after_expiry','over_stay'}
);
create index visits_open_idx on visits (tenant_id, category_id) where time_out is null;

create table gate_decisions (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id),
  gate_id uuid not null references gates(id),
  at timestamptz not null default now(),
  pass_id uuid references passes(id),
  plate_query text,
  verdict text not null check (verdict in ('allow','allow_overage','wait','deny','wrong_gate','no_pass')),
  reasons jsonb not null,                   -- [{"code":"quota_full","quota":"...","occupied":25,"capacity":25}]
  action text,                              -- 'check_in','check_out','refuse','redirect','override','none'
  override_reason text,
  guard_id uuid, device_id uuid,
  snapshot jsonb
);

create table gate_requests (
  id uuid primary key default gen_random_uuid(),
  gate_id uuid not null references gates(id),
  tenant_id uuid references tenants(id),
  plate_norm text, category_id uuid references vehicle_categories(id), person_name text,
  status text not null check (status in ('open','approved','rejected','timeout')),
  created_by uuid, answered_by uuid, answered_at timestamptz,
  pass_id uuid references passes(id)
);

-- ========== Нарушения и начисления ==========
create table violations (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id),
  tenant_id uuid references tenants(id),
  visit_id uuid references visits(id),
  kind text not null,                       -- 'parking_outside','speeding','smoking','repair',...
  rule_ref text,                            -- «Правила, п. 3»
  fine_rub numeric(10,2),
  photos text[],
  status text not null default 'draft' check (status in ('draft','signed','disputed','cancelled')),
  created_by uuid, created_at timestamptz not null default now()
);

create table overage_charges (
  id uuid primary key default gen_random_uuid(),
  quota_id uuid not null references quotas(id),
  visit_id uuid not null references visits(id),
  day date not null,                        -- местная дата объекта
  tariff_rub numeric(10,2) not null,
  unique (visit_id, day)
);

-- ========== Люди, устройства, аудит ==========
create table users (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  full_name text not null, email text, phone text,
  pin_hash text,                            -- для охраны
  status text not null default 'invited' check (status in ('invited','active','disabled'))
);

create table roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name text not null,
  permissions text[] not null default '{}'  -- новая роль — без прав
);

create table role_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  role_id uuid not null references roles(id),
  scope_site_id uuid references sites(id),     -- null = вся организация
  scope_tenant_id uuid references tenants(id), -- для пользователей арендатора
  scope_gate_id uuid references gates(id)      -- для охраны конкретного КПП
);

create table gate_devices (
  id uuid primary key default gen_random_uuid(),
  gate_id uuid not null references gates(id),
  name text not null,
  token_hash text not null,
  last_seen_at timestamptz,
  revoked_at timestamptz
);

create table shifts (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references gate_devices(id),
  guard_id uuid not null references users(id),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  handover_note text
);

create table audit_log (
  id bigserial primary key,
  organization_id uuid not null,
  at timestamptz not null default now(),
  actor_id uuid, device_id uuid,
  entity text not null, entity_id uuid not null,
  action text not null,                     -- 'create','update','delete','approve',...
  diff jsonb,                               -- {"category":{"from":"фура","to":"легковой"}}
  reason text
);
