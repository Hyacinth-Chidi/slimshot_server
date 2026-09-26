import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

loadEnv({ path: resolve(process.cwd(), '.env') });

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../src/generated/prisma/client';

/**
 * Creates the default Cloudinary provider row if none exists. The row is only
 * the identity asset files point at — credentials come from CLOUDINARY_* in
 * the environment and are never stored in the database.
 */
async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });

  const existing = await prisma.storageProvider.findFirst({ where: { isDefault: true } });
  if (existing) {
    console.log('Default storage provider already present — nothing to seed.');
  } else {
    await prisma.storageProvider.create({
      data: {
        kind: 'cloudinary',
        name: 'Primary Cloudinary',
        isDefault: true,
        isActive: true,
        publicConfig: { folder: process.env.CLOUDINARY_AUDIO_FOLDER ?? 'slimshot/audio' },
      },
    });
    console.log('Seeded default Cloudinary storage provider.');
  }
  await prisma.$disconnect();
}

void main();
