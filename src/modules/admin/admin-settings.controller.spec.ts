import { HEADERS_METADATA } from '@nestjs/common/constants';
import 'reflect-metadata';

import { AdminSettingsController } from './admin-settings.controller';

/**
 * `@Header(...)` records its name/value pairs as method metadata rather than
 * running any code, so the only reliable way to assert "this handler sets
 * this header" without booting a full Nest HTTP server is to read that
 * metadata back with Reflect, exactly as Nest's own interceptor does at
 * request time.
 */
function headersOn(methodName: keyof AdminSettingsController): Array<{
  name: string;
  value: string;
}> {
  const fn = AdminSettingsController.prototype[methodName] as unknown as (
    ...args: unknown[]
  ) => unknown;
  return (Reflect.getMetadata(HEADERS_METADATA, fn) as
    | Array<{ name: string; value: string }>
    | undefined) ?? [];
}

describe('AdminSettingsController Cache-Control', () => {
  // M6: GET /settings returns only masked values, but a mask still reveals up
  // to a third of a secret (e.g. a 43-char Redis URL masks to
  // 'redis://••••6379'), which should not sit in a shared proxy cache.
  it('sends no-store on GET /settings, not just on reveal', () => {
    expect(headersOn('list')).toContainEqual({
      name: 'Cache-Control',
      value: 'no-store',
    });
  });

  it('still sends no-store on POST /settings/:key/reveal', () => {
    expect(headersOn('reveal')).toContainEqual({
      name: 'Cache-Control',
      value: 'no-store',
    });
  });

  // PUT /settings/:key returns only { updated: true }, no setting value, so
  // it is not required to carry the header — this pins that expectation so a
  // future addition of a returned value is the trigger to reconsider it.
  it('does not require no-store on PUT /settings/:key, which returns no value', () => {
    expect(headersOn('update')).not.toContainEqual({
      name: 'Cache-Control',
      value: 'no-store',
    });
  });
});
