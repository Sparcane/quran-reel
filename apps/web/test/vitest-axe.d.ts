// vitest-axe 0.1 augments the legacy global `Vi` namespace, which Vitest 5 no
// longer uses. Re-augment the actual `vitest` module so the matcher typechecks.
import 'vitest';
import type { AxeMatchers } from 'vitest-axe';

declare module 'vitest' {
  interface Assertion<T = any> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}
