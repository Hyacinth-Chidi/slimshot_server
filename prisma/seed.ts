import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

loadEnv({ path: resolve(process.cwd(), '.env') });

import { PrismaPg } from '@prisma/adapter-pg';

import { ensureR2Default } from '../src/core/storage/default-storage';
import { PrismaClient } from '../src/generated/prisma/client';

/**
 * Makes Cloudflare R2 the default storage provider (switching over a database
 * that still defaults to Cloudinary). The row is only the identity asset files
 * point at; credentials come from R2_* in the environment and are never stored
 * in the database. Safe to run on every deploy.
 */
async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });

  const outcome = await ensureR2Default(prisma, process.env.R2_BUCKET?.trim() || undefined);
  console.log(
    {
      unchanged: 'Default storage provider is already Cloudflare R2: nothing to seed.',
      created: 'Seeded Cloudflare R2 as the default storage provider.',
      switched: 'Switched the default storage provider to Cloudflare R2.',
    }[outcome],
  );
  await prisma.$disconnect();
}

void main();
