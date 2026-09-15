import { SetMetadata } from '@nestjs/common';

import { AdminRole } from '../../generated/prisma/enums';

export const PERMISSIONS = [
  'asset.read',
  'asset.create',
  'asset.update',
  'asset.publish',
  'asset.delete',
  'taxonomy.read',
  'taxonomy.write',
  'settings.read',
  'settings.write',
  'storage.manage',
  'admin.manage',
  'audit.read',
  'jobs.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: readonly Permission[] = [
  'asset.read',
  'taxonomy.read',
  'settings.read',
  'audit.read',
  'jobs.read',
];

const EDITOR: readonly Permission[] = [
  ...VIEWER,
  'asset.create',
  'asset.update',
  'asset.publish',
  'taxonomy.write',
];

const ADMIN: readonly Permission[] = [...EDITOR, 'asset.delete'];

const OWNER: readonly Permission[] = [
  ...ADMIN,
  'settings.write',
  'storage.manage',
  'admin.manage',
];

export const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  [AdminRole.owner]: OWNER,
  [AdminRole.admin]: ADMIN,
  [AdminRole.editor]: EDITOR,
  [AdminRole.viewer]: VIEWER,
};

export function roleHas(role: AdminRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export const PERMISSION_KEY = 'required_permission';

export const RequirePermission = (permission: Permission) =>
  SetMetadata(PERMISSION_KEY, permission);
