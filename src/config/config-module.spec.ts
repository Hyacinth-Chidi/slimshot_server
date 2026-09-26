import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { appConfig, type AppConfig } from './app.config';
import { validate } from './env.validation';
import { uploadConfig, type UploadConfig } from './upload.config';

/**
 * Boots the real ConfigModule from a real .env file, the way the server does.
 * Unit tests that set process.env directly cannot see how forRoot moves values
 * from the file into process.env — which is exactly where list values used to
 * get lost.
 */
describe('ConfigModule loading a .env file', () => {
  const keys = ['CORS_ALLOWED_ORIGINS', 'UPLOAD_AUDIO_MIME_TYPES', 'ADMIN_BASE_URL'];
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slimshot-env-'));
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('applies list variables from the file, not their defaults', async () => {
    const envFile = join(dir, '.env');
    writeFileSync(
      envFile,
      [
        'CORS_ALLOWED_ORIGINS=https://a.example.com,https://b.example.com',
        'UPLOAD_AUDIO_MIME_TYPES=audio/mpeg',
        'ADMIN_BASE_URL=',
      ].join('\n'),
    );

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ envFilePath: [envFile], validate, load: [appConfig, uploadConfig] }),
      ],
    }).compile();

    expect(moduleRef.get<AppConfig>(appConfig.KEY).corsOrigins).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
    expect(moduleRef.get<UploadConfig>(uploadConfig.KEY).limits.audio?.mimeTypes).toEqual([
      'audio/mpeg',
    ]);
  });

  it('still refuses to boot on an invalid value in the file', async () => {
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'CORS_ALLOWED_ORIGINS=not-a-url\n');
    await expect(
      Test.createTestingModule({
        imports: [ConfigModule.forRoot({ envFilePath: [envFile], validate, load: [appConfig] })],
      }).compile(),
    ).rejects.toThrow(/CORS_ALLOWED_ORIGINS/);
  });
});
