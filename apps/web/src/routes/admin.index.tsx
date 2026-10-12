import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
} from '@oxrana/ui';
import { createFileRoute, Link } from '@tanstack/react-router';
import { nextUnfinished } from '../components/wizard';
import { useMe } from '../lib/data';
import { STEPS, stepBySlug, useSetupProgress } from '../lib/setup';
import { useSite } from '../lib/site-context';

export const Route = createFileRoute('/admin/')({
  component: AdminHome,
});

/** Обзор админки: на чистой базе — приглашение к мастеру; дальше — состояние настройки. */
function AdminHome() {
  const { me, can } = useMe();
  const { site, loading } = useSite();
  const { progress } = useSetupProgress(me);
  const doneCount = STEPS.filter((s) => progress[s.slug]?.state === 'done').length;
  const next = stepBySlug(nextUnfinished(progress, can));
  const canSetup = can('site.manage');
  return (
    <>
      <PageHeader
        title={site ? site.name : 'Добро пожаловать'}
        description={
          site
            ? `Время объекта: ${site.timezoneLabel}.`
            : 'База пока пустая. Объект настраивается здесь, через интерфейс.'
        }
      />
      {!loading && !site ? (
        <Card>
          <CardHeader>
            <CardTitle>Настроим объект с нуля</CardTitle>
            <CardDescription>
              Мастер проведёт по шагам: объект, КПП, типы транспорта, маршруты, доки, арендаторы,
              лимиты, политики. Ориентир — около часа.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {canSetup ? (
              <Button asChild size="lg">
                <Link to="/admin/setup/$step" params={{ step: 'site' }}>
                  Начать настройку
                </Link>
              </Button>
            ) : (
              <Alert tone="warning" title="Нет права «управление объектом»">
                Попросите владельца организации создать объект или выдать вам роль с этим правом.
              </Alert>
            )}
          </CardContent>
        </Card>
      ) : null}
      {site ? (
        <Card>
          <CardHeader>
            <CardTitle>
              Настроено шагов: {doneCount} из {STEPS.length}
            </CardTitle>
            <CardDescription>
              {next && next.slug !== 'check'
                ? `Дальше: ${next.n}. ${next.title} — ${progress[next.slug]?.summary ?? next.short}`
                : 'Обязательные шаги выполнены. Откройте проверку, чтобы увидеть сводку.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {canSetup && next ? (
              <Button asChild>
                <Link to="/admin/setup/$step" params={{ step: next.slug }}>
                  Продолжить настройку
                </Link>
              </Button>
            ) : null}
            <Button asChild variant="outline">
              <Link to="/admin/setup">Все шаги</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
