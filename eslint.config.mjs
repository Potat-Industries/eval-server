import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  { files: ['**/*.{ts}'], plugins: { js }, extends: ['js/recommended'] },
  { files: ['**/*.{ts}'], languageOptions: { globals: globals.browser } },
  // @ts-expect-error i dont care
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
          ...globals.browser,
          ...Object.fromEntries(Object.entries(globals.commonjs).map(([key]) => [key, 'off'])),
      },

      ecmaVersion: 2025,
      sourceType: 'module',

      parserOptions: {
          requireConfigFile: false,
          babelOptions: { plugins: ['@typescript-eslint/eslint-plugin'] },
      },
    },

    rules: {
      strict: ['error', 'global'],

      quotes: ['error', 'single', {
          allowTemplateLiterals: true,
          avoidEscape: true,
      }],

      'no-eval': 'off',
      'new-cap': 'off',
      'no-promise-executor-return': 'off',
      'no-plusplus': 'off',

      'no-await-in-loop': 'off',
      'no-restricted-syntax': 'off',
      'no-continue': 'off',
      'global-require': 'off',
      'no-unused-expressions': 'off',
      'one-var': 'off',
      'no-void': 'off',
      'no-param-reassign': 'off',
      'no-global-assign': 'off',
      'no-unsafe-optional-chaining': 'off',
      'consistent-return': 'off',
      'no-new': 'off',
      'no-bitwise': 'off',
      'class-methods-use-this': 'off',
      'no-new-object': 'off',
      'func-names': 'off',
      'no-underscore-dangle': 'off',
      'no-use-before-define': 'off',
      'no-return-assign': 'off',
      'operator-linebreak': 'off',
      'no-shadow': 'off',
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      'array-callback-return': 'off',
      'max-classes-per-file': 'off',
      semi: ['error', 'always'],
      'linebreak-style': ['error', 'unix'],
      radix: 'off',

      'comma-dangle': ['error', {
        arrays: 'always-multiline',
        objects: 'always-multiline',
        imports: 'always-multiline',
        exports: 'always-multiline',
        functions: 'always-multiline',
      }],
    },
  }, {
    files: ['tests/**/*', '**/*.d.ts'],
  },
]);
