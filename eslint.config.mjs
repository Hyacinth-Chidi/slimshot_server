import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'src/generated/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Only DATABASE_URL, MASTER_ENCRYPTION_KEY, PORT and NODE_ENV may come from env. Everything else reads from SettingsService.',
        },
      ],
    },
  },
  {
    files: [
      'src/prisma/prisma.service.ts',
      'src/main.ts',
      'prisma.config.ts',
      'test/**',
      '**/*.spec.ts',
      'src/core/crypto/crypto.module.ts',
      'src/modules/auth/auth.service.ts',
      'prisma/seed.ts',
    ],
    rules: { 'no-restricted-properties': 'off' },
  },
);
