import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library unmounts its trees between tests only when the test globals
// exist; Vitest runs without globals here, so the DOM would otherwise pile up
// from one test to the next and every count would be wrong.
afterEach(() => {
  cleanup();
});
