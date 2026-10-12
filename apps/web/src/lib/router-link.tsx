import type { LinkComponent } from '@oxrana/ui';
import { useRouter } from '@tanstack/react-router';

/**
 * Ссылка packages/ui через маршрутизатор: внутренний адрес открывается без перезагрузки страницы.
 * Адреса из ответов API (`settingLink`) — строки, поэтому ссылка не типизирована маршрутами.
 */
export const RouterLink: LinkComponent = ({ href, children, ...rest }) => {
  const router = useRouter();
  return (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) return;
        if (!href.startsWith('/')) return;
        event.preventDefault();
        void router.navigate({ to: href });
      }}
    >
      {children}
    </a>
  );
};
