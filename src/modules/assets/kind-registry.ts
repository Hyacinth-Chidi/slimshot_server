import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import { AssetKind, FileRole } from '../../generated/prisma/enums';
import {
  ASSET_KIND_DESCRIPTOR,
  AssetKindDescriptor,
} from './asset-kind.interface';

@Injectable()
export class KindRegistry {
  private readonly byKind = new Map<AssetKind, AssetKindDescriptor>();

  constructor(
    @Inject(ASSET_KIND_DESCRIPTOR) descriptors: AssetKindDescriptor[],
  ) {
    for (const descriptor of descriptors) {
      if (this.byKind.has(descriptor.kind)) {
        throw new Error(
          `Duplicate asset kind descriptor registered for: ${descriptor.kind}`,
        );
      }
      this.byKind.set(descriptor.kind, descriptor);
    }
  }

  get(kind: AssetKind): AssetKindDescriptor {
    const descriptor = this.byKind.get(kind);
    if (!descriptor) {
      throw new Error(`No descriptor registered for asset kind: ${kind}`);
    }
    return descriptor;
  }

  all(): AssetKindDescriptor[] {
    return [...this.byKind.values()];
  }

  requiredRoles(kind: AssetKind): FileRole[] {
    return this.get(kind)
      .fileRoles.filter((r) => r.required)
      .map((r) => r.role);
  }

  /**
   * Allowed mime types and the size cap are passed in rather than read here,
   * because they live in SettingsService and this class stays synchronous.
   */
  assertAccepts(
    kind: AssetKind,
    mimeType: string,
    byteSize: number,
    allowedMimeTypes: string[],
    maxBytes: number,
  ): void {
    this.get(kind);

    if (!allowedMimeTypes.includes(mimeType)) {
      throw new BadRequestException(
        `${mimeType} is not an accepted type for ${kind}. ` +
          `Allowed: ${allowedMimeTypes.join(', ')}`,
      );
    }

    if (byteSize > maxBytes) {
      throw new BadRequestException(
        `File size ${byteSize} exceeds the configured maximum of ${maxBytes} bytes.`,
      );
    }
  }
}
