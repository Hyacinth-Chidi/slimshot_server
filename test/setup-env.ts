process.env.NODE_ENV = 'test';
// Test-only values, never real credentials. Every required variable is set so
// config namespaces can be built in any spec.
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 't'.repeat(48);
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? '0'.repeat(32);
process.env.R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID ?? 'test-access-key';
process.env.R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY ?? 'test-secret-key';
process.env.R2_BUCKET = process.env.R2_BUCKET ?? 'test-bucket';
process.env.R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL ?? 'https://cdn.test';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY ?? 'ab'.repeat(32);
process.env.USER_JWT_SECRET = process.env.USER_JWT_SECRET ?? 'u'.repeat(48);
process.env.IDENTITY_HMAC_SECRET = process.env.IDENTITY_HMAC_SECRET ?? 'i'.repeat(48);
