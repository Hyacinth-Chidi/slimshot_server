process.env.NODE_ENV = 'test';
// Test-only values, never real credentials. Every required variable is set so
// config namespaces can be built in any spec.
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 't'.repeat(48);
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME ?? 'test-cloud';
process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY ?? 'test-key';
process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET ?? 'test-secret';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY ?? 'ab'.repeat(32);
process.env.USER_JWT_SECRET = process.env.USER_JWT_SECRET ?? 'u'.repeat(48);
process.env.IDENTITY_HMAC_SECRET = process.env.IDENTITY_HMAC_SECRET ?? 'i'.repeat(48);
