import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../src/lib/contrast';
import { renderRoute, ROUTES } from './render-route';

describe('budget de performance', () => {
  for (const page of ROUTES) {
    it(`${page} : moins de 2000 nœuds DOM`, () => {
      const { container } = renderRoute(page);
      expect(container.querySelectorAll('*').length).toBeLessThan(2000);
    });
  }

  it('le gris atténué reste lisible sur le fond sombre (≥ 4.5:1)', () => {
    expect(contrastRatio('#a1a1a1', '#0a0a0a')).toBeGreaterThanOrEqual(4.5);
  });
});
