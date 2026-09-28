import { UnprocessableEntityException } from '@nestjs/common';

import { ProviderCapability, ProviderKind } from '../../generated/prisma/enums';

/**
 * Path and query values erase to plain strings at runtime; without this a
 * typo in `:provider` would reach Prisma and surface as a 500.
 */
function assertOneOf<T extends string>(value: unknown, allowed: Record<string, T>, name: string): T {
  const known = Object.values(allowed);
  if (typeof value === 'string' && (known as string[]).includes(value)) return value as T;
  throw new UnprocessableEntityException(`${name} must be one of: ${known.join(', ')}.`);
}

export function assertProvider(value: unknown): ProviderKind {
  return assertOneOf(value, ProviderKind, 'provider');
}

export function assertCapability(value: unknown): ProviderCapability {
  return assertOneOf(value, ProviderCapability, 'capability');
}
