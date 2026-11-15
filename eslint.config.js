import js from '@eslint/js';

export default [
  {
    ignores: ['**/node_modules/**', '**/.next/**', '**/out/**', '**/dist/**', '**/.superpowers/**', '**/playwright-report/**'],
  },
  js.configs.recommended,
];
