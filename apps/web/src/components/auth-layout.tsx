import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  cn,
  type ErrorView,
  type FieldErrorLike,
  ThemeToggle,
} from '@oxrana/ui';
import type { ReactNode } from 'react';

/**
 * Макет экранов входа, приглашения и главной: карточка по центру, переключатель темы в углу.
 * Заголовок страницы (`h1`) — внутри карточки.
 */
export function AuthLayout({
  title,
  description,
  children,
  footer,
  wide = false,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center bg-background px-4 py-12">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <p className="mb-4 text-sm font-medium text-muted-foreground">Платформа пропускного режима</p>
      <Card className={cn('w-full', wide ? 'max-w-xl' : 'max-w-md')}>
        <CardHeader className="pb-2">
          <h1 className="text-xl font-semibold leading-tight">{title}</h1>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
        {footer ? <CardFooter className="flex-col items-start gap-2">{footer}</CardFooter> : null}
      </Card>
    </main>
  );
}

/**
 * Ошибка сервера у поля, если она про это поле (`field`), иначе `null` — тогда её показывает
 * баннер над кнопкой.
 */
export function fieldErrorOf(view: ErrorView | null, ...names: string[]): FieldErrorLike | null {
  if (!view?.field || !names.includes(view.field)) return null;
  return { message: view.message, settingLink: view.settingLink };
}

/** Ошибка, не привязанная ни к одному полю формы, — для баннера. */
export function generalErrorOf(view: ErrorView | null, ...names: string[]): ErrorView | null {
  if (!view) return null;
  return view.field && names.includes(view.field) ? null : view;
}
