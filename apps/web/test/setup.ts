import '@testing-library/jest-dom/vitest';
import 'vitest-axe/extend-expect';
import { cleanup } from '@testing-library/react';
import { afterEach, expect } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';

// One registration for the whole suite, so any test can assert
// `expect(await axe(node)).toHaveNoViolations()`.
expect.extend(axeMatchers);

// Testing Library unmounts its trees between tests only when the test globals
// exist; Vitest runs without globals here, so the DOM would otherwise pile up
// from one test to the next and every count would be wrong.
afterEach(() => {
  cleanup();
});
