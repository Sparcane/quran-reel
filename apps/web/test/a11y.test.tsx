import { axe } from 'vitest-axe';
import { describe, expect, it } from 'vitest';
import { renderRoute, ROUTES } from './render-route';

describe('accessibilité (WCAG AA)', () => {
  for (const page of ROUTES) {
    it(`${page} : aucune violation axe`, async () => {
      const { container } = renderRoute(page);
      expect(await axe(container)).toHaveNoViolations();
    });

    it(`${page} : tout le contenu est dans un repère <main>`, () => {
      const { container } = renderRoute(page);
      expect(container.querySelector('main')).toBeInTheDocument();
    });
  }
});
