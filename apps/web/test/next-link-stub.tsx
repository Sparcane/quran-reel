// Test stand-in for `next/link`: the real component needs the App Router to be
// mounted, which unit tests do not do. It renders the anchor `next/link`
// renders, so link semantics and hrefs are still what the user gets.
import type { AnchorHTMLAttributes, ReactNode } from 'react';

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string | { pathname?: string };
  children: ReactNode;
}

export default function Link({ href, children, ...rest }: LinkProps) {
  const url = typeof href === 'string' ? href : (href.pathname ?? '');
  return (
    <a href={url} {...rest}>
      {children}
    </a>
  );
}
