import { cva, type VariantProps } from 'class-variance-authority';
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { useLinkComponent } from '../config';
import { cn } from '../lib/cn';

const alertVariants = cva('flex gap-3 rounded-md border p-3 text-sm', {
  variants: {
    tone: {
      info: 'border-transparent bg-info-soft text-foreground',
      success: 'border-transparent bg-success-soft text-foreground',
      warning: 'border-transparent bg-warning-soft text-foreground',
      danger: 'border-transparent bg-danger-soft text-foreground',
    },
  },
  defaultVariants: { tone: 'info' },
});

const ICONS = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: OctagonAlert,
} as const;
const ICON_COLOR = {
  info: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
} as const;

export function Alert({
  className,
  tone = 'info',
  title,
  children,
  action,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, 'title'> &
  VariantProps<typeof alertVariants> & { title?: ReactNode; action?: ReactNode }) {
  const Icon = ICONS[tone ?? 'info'];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(alertVariants({ tone }), className)}
      {...props}
    >
      <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', ICON_COLOR[tone ?? 'info'])} />
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="text-foreground/90">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** Ошибка API: причина и ссылка на настройку, где её исправить (CLAUDE.md п. 8). */
export function ErrorAlert({
  error,
  className,
}: {
  error: { message: string; settingLink: string | null } | null;
  className?: string;
}) {
  const Link = useLinkComponent();
  if (!error) return null;
  return (
    <Alert tone="danger" className={className}>
      {error.message}
      {error.settingLink ? (
        <>
          {' '}
          <Link href={error.settingLink} className="font-medium text-primary underline">
            Перейти к настройке
          </Link>
        </>
      ) : null}
    </Alert>
  );
}
