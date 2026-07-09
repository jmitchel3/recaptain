// Minimal ESLint flat config: catches syntax errors, typos, and common
// sloppiness without being opinionated about style.
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        ...globals.webextensions,
        ...globals.node,
        createImageBitmap: 'readonly',
        OffscreenCanvas: 'readonly',
        indexedDB: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-assignment': 'off', // noisy on defensive init-then-assign
      eqeqeq: ['error', 'smart'],
      'prefer-const': ['warn', { destructuring: 'all' }],
      'no-var': 'error',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '*.recaptain'],
  },
];
