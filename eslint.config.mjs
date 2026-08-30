import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default [
  {
    ignores: ['.next/**', 'node_modules/**', 'apps-script/**', 'tools/**', 'scripts/**']
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      // Tests reach into modules dynamically and assert on shapes the types
      // deliberately do not describe; `any` there is the point, not an oversight.
      '@typescript-eslint/no-explicit-any': 'warn',
      // A leading underscore is the established way to say "this parameter
      // exists for the signature, not for the body".
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_'
      }]
    }
  }
];
