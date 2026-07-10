// @ts-check

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';

export default defineConfig([
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '*.min.js'],
  },

  {
    files: ['src/**/*.ts'],

    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.stylisticTypeChecked,

      // Keep this last so it disables ESLint rules that conflict with Prettier.
      eslintConfigPrettier,
    ],

    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },

    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },

    rules: {
      /*
       * General correctness
       */
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],
      'no-else-return': ['error', { allowElseIf: false }],
      'no-console': 'off',

      /*
       * Imports and types
       */
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
        },
      ],

      '@typescript-eslint/no-import-type-side-effects': 'error',

      /*
       * Variables
       *
       * Prefix intentionally unused values with an underscore.
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      /*
       * Useful additional type-aware checks
       */
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        {
          allowDefaultCaseForExhaustiveSwitch: false,
          requireDefaultForNonUnion: false,
        },
      ],

      /*
       * Useful, but sometimes necessary during development.
       */
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',

      /*
       * Usually unnecessary with TypeScript inference.
       */
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
]);
