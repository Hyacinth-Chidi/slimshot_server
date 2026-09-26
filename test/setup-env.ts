process.env.NODE_ENV = 'test';
process.env.MASTER_ENCRYPTION_KEY =
  process.env.MASTER_ENCRYPTION_KEY ??
  '0'.repeat(64); // 32 bytes hex — test-only, never a real key
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? 't'.repeat(48); // test-only, never a real secret
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test';
