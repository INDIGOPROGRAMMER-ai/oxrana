import { type ComponentType, createContext, type ReactNode, useContext } from 'react';

/** Ссылка приложения: в кабинете — через маршрутизатор, по умолчанию — обычный `<a>`. */
export type LinkComponent = ComponentType<{
  href: string;
  className?: string;
  children?: ReactNode;
  'aria-label'?: string;
}>;

const DefaultLink: LinkComponent = ({ href, children, ...rest }) => (
  <a href={href} {...rest}>
    {children}
  </a>
);

const LinkContext = createContext<LinkComponent>(DefaultLink);

export function UiProvider({ link, children }: { link?: LinkComponent; children: ReactNode }) {
  return <LinkContext.Provider value={link ?? DefaultLink}>{children}</LinkContext.Provider>;
}

export function useLinkComponent(): LinkComponent {
  return useContext(LinkContext);
}
