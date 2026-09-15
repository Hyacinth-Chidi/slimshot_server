import { AdminRole } from '../../generated/prisma/enums';
import { ROLE_PERMISSIONS, roleHas } from './permissions';

describe('permissions', () => {
  it('owner has every permission any other role has', () => {
    const others = [AdminRole.admin, AdminRole.editor, AdminRole.viewer];
    for (const role of others) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(ROLE_PERMISSIONS[AdminRole.owner]).toContain(permission);
      }
    }
  });

  it('only owner may write system settings', () => {
    expect(roleHas(AdminRole.owner, 'settings.write')).toBe(true);
    expect(roleHas(AdminRole.admin, 'settings.write')).toBe(false);
    expect(roleHas(AdminRole.editor, 'settings.write')).toBe(false);
  });

  it('editor may upload and edit but not delete', () => {
    expect(roleHas(AdminRole.editor, 'asset.create')).toBe(true);
    expect(roleHas(AdminRole.editor, 'asset.update')).toBe(true);
    expect(roleHas(AdminRole.editor, 'asset.delete')).toBe(false);
  });

  it('viewer may only read', () => {
    expect(roleHas(AdminRole.viewer, 'asset.read')).toBe(true);
    expect(roleHas(AdminRole.viewer, 'asset.create')).toBe(false);
    expect(roleHas(AdminRole.viewer, 'asset.publish')).toBe(false);
  });

  it('only owner may manage other admins', () => {
    expect(roleHas(AdminRole.owner, 'admin.manage')).toBe(true);
    expect(roleHas(AdminRole.admin, 'admin.manage')).toBe(false);
  });
});
