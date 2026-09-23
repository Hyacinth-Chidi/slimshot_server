import { Reflector } from '@nestjs/core';

import { PERMISSION_KEY } from './permissions';
import { AuthController } from '../../modules/auth/auth.controller';
import { AdminAssetsController } from '../../modules/admin/admin-assets.controller';
import { AdminAuditController } from '../../modules/admin/admin-audit.controller';
import { AdminCategoriesController } from '../../modules/admin/admin-categories.controller';
import { AdminJobsController } from '../../modules/admin/admin-jobs.controller';
import { AdminKindsController } from '../../modules/admin/admin-kinds.controller';
import { AdminSettingsController } from '../../modules/admin/admin-settings.controller';
import { AdminStatsController } from '../../modules/admin/admin-stats.controller';

/**
 * Controllers whose routes are deliberately reachable without a declared permission.
 * Auth endpoints must be: you cannot require a permission to log in.
 */
const PUBLIC_BY_DESIGN = new Set<string>(['AuthController']);

/**
 * Every admin controller added by later tasks must be listed here. The point is that
 * adding a controller and forgetting to guard its methods fails loudly rather than
 * silently becoming reachable by any authenticated role.
 */
const ADMIN_CONTROLLERS: Array<new (...args: never[]) => object> = [
  AdminAssetsController,
  AdminKindsController,
  AdminCategoriesController,
  AdminStatsController,
  AdminAuditController,
  AdminJobsController,
  AdminSettingsController,
];

describe('admin route guarding', () => {
  const reflector = new Reflector();

  it('lists AuthController as public by design, deliberately', () => {
    // A guard against someone "fixing" the list by emptying it.
    expect(PUBLIC_BY_DESIGN.has(AuthController.name)).toBe(true);
  });

  it.each(ADMIN_CONTROLLERS.length ? ADMIN_CONTROLLERS : [null])(
    'every handler on %p declares a required permission',
    (controller) => {
      if (controller === null) {
        // No admin controllers exist yet (they arrive in Task 20). Passing
        // vacuously is correct; the list above is what future tasks extend.
        expect(ADMIN_CONTROLLERS).toHaveLength(0);
        return;
      }

      const proto = controller.prototype as object;
      const methods = Object.getOwnPropertyNames(proto).filter(
        (m) => m !== 'constructor' && typeof (proto as Record<string, unknown>)[m] === 'function',
      );

      const unguarded = methods.filter(
        (m) =>
          !reflector.get(PERMISSION_KEY, (proto as Record<string, () => void>)[m]),
      );

      expect(unguarded).toEqual([]);
    },
  );
});
