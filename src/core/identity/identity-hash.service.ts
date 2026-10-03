import { Inject, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';

import { appAuthConfig, type AppAuthConfig } from '../../config';

/** Keyed hashes for everything we keep about a person or a device. */
@Injectable()
export class IdentityHashService {
  constructor(@Inject(appAuthConfig.KEY) private readonly cfg: AppAuthConfig) {}

  hash(kind: string, value: string): string {
    return createHmac('sha256', this.cfg.identityHmacSecret).update(`${kind}:${value}`).digest('hex');
  }
}
