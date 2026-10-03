import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { DeletionPageController } from './deletion-page.controller';

describe('account deletion page', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [DeletionPageController] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the page with a strict content security policy', async () => {
    const res = await fetch(`${base}/account-deletion`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    const html = await res.text();
    expect(html).toContain('id="form-email"');
    expect(html).toContain('<script src="/account-deletion/app.js"');
  });

  it('serves the script that calls the deletion endpoints', async () => {
    const res = await fetch(`${base}/account-deletion/app.js`);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toContain('/api/app/v1/account-deletion/');
  });
});
