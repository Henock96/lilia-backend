import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';

/**
 * Flat config ESLint (ESLint 10 — `.eslintrc.js` n'est plus supporté).
 *
 * Le monorepo web a migré en juin 2026 (commit f81f728), le backend avait été
 * oublié : `npm run lint` échouait donc systématiquement et plus rien n'était
 * linté. Portage à l'identique des règles de l'ancien `.eslintrc.js`.
 *
 * @type {import('eslint').Linter.Config[]}
 */
export default tseslint.config(
  {
    // Rien à linter dans les artefacts de build ni dans le client Prisma généré.
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'generated/**',
      'prisma/generated/**',
      'eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierRecommended,
  {
    languageOptions: {
      parserOptions: {
        project: 'tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      // Reprises telles quelles de l'ancienne config — le code existant s'appuie
      // dessus ; les resserrer est un chantier à part.
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // Convention `_` déjà en vigueur côté web (`@lilia/config/eslint`) : le
      // code utilise la déstructuration avec préfixe `_` pour retirer des champs
      // d'une réponse (`const { _owner, ...safe } = row`). C'est intentionnel.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
);
