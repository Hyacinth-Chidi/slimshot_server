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
      'prisma.config.ts',
      'test/**',
      '**/*.spec.ts',
      'prisma/seed.ts',
    ],
    rules: { 'no-restricted-properties': 'off' },
  },
);
