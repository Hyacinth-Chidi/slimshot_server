import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

loadEnv({ path: resolve(process.cwd(), '.env') });

import { PrismaPg } from '@prisma/adapter-pg';

import { Prisma, PrismaClient } from '../src/generated/prisma/client';
import { EnvelopeCryptoService } from '../src/core/crypto/envelope-crypto.service';

async function main(): Promise<void> {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const prisma = new PrismaClient({ adapter });
  const crypto = new EnvelopeCryptoService(process.env.MASTER_ENCRYPTION_KEY!);

  const existing = await prisma.storageProvider.findFirst({
    where: { isDefault: true },
  });

  if (existing) {
    console.log('Default storage provider already present — nothing to seed.');
    await prisma.$disconnect();
    return;
  }

  const sealed = crypto.encrypt(
    JSON.stringify({
      cloudName: requireEnv('CLOUDINARY_CLOUD_NAME'),
      apiKey: requireEnv('CLOUDINARY_API_KEY'),
      apiSecret: requireEnv('CLOUDINARY_API_SECRET'),
      folder: process.env.CLOUDINARY_AUDIO_FOLDER ?? 'slimshot/audio',
    }),
  );

  await prisma.storageProvider.create({
    data: {
      kind: 'cloudinary',
      name: 'Primary Cloudinary',
      isDefault: true,
      isActive: true,
      configCipher: sealed.cipher.subarray(0) as Prisma.Bytes,
      keyVersion: sealed.keyVersion,
      publicConfig: { folder: process.env.CLOUDINARY_AUDIO_FOLDER ?? 'slimshot/audio' },
    },
  });

  console.log('Seeded default Cloudinary storage provider.');
  await prisma.$disconnect();
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} must be set to seed the storage provider.`);
  return value;
}

void main();
