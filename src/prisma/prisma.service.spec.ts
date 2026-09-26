// PrismaClient checks the adapter's provider and name in its constructor, so
// the stand-in has to look like the real adapter factory.
jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest.fn().mockImplementation((opts: unknown) => ({
    provider: 'postgres',
    adapterName: '@prisma/adapter-pg',
    opts,
  })),
}));

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  it('connects with the configured database URL, not process.env', () => {
    new PrismaService({ url: 'postgresql://configured/db' });
    expect(PrismaPg).toHaveBeenCalledWith({ connectionString: 'postgresql://configured/db' });
  });
});
