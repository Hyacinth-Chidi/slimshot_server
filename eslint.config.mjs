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
          message: 'Read configuration by injecting a src/config namespace, not process.env.',
        },
      ],
    },
  },
  {
    files: [
      // The one place configuration is parsed and validated.
      'src/config/**',
      'src/prisma/prisma.service.ts',
      'src/main.ts',
      'prisma.config.ts',
      'test/**',
      '**/*.spec.ts',
      'src/core/crypto/crypto.module.ts',
      // JWT secret and token lifetimes are deployment config, read once at boot.
      'src/modules/auth/jwt-config.ts',
      'src/modules/auth/auth.service.ts',
      'prisma/seed.ts',
      // Reads ONLY the env var a setting definition names in `envFallback`,
      // and only when no database row exists. The registry still decides what
      // is configurable; this does not reintroduce ad-hoc env reads.
      'src/core/settings/settings.service.ts',
    ],
    rules: { 'no-restricted-properties': 'off' },
  },
);
