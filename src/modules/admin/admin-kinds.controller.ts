import { Controller, Get, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { KindRegistry } from '../assets/kind-registry';

@Controller('api/admin/v1/kinds')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminKindsController {
  constructor(private readonly kinds: KindRegistry) {}

  /** Describes the upload contract so a dashboard can render a form per kind. */
  @Get()
  @RequirePermission('asset.read')
  list() {
    return {
      success: true as const,
      data: this.kinds.all().map((d) => ({
        kind: d.kind,
        label: d.label,
        extensions: d.accepts.extensions,
        fileRoles: d.fileRoles,
      })),
    };
  }
}
