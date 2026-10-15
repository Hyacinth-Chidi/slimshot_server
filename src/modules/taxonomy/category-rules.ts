import { HttpStatus } from '@nestjs/common';

import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import type { AssetKind } from '../../generated/prisma/enums';

export interface CategoryReader {
  category: {
    findUnique(args: {
      where: { id: string };
      select: { kind: true };
    }): Promise<{ kind: AssetKind } | null>;
  };
}

/**
 * A sound may be filed under any category of its own kind, hidden or not (the
 * owner can prepare a pill before showing it). Categories are hard-deleted and
 * deletion refuses while assets use them, so "exists" also means "not deleted".
 */
export async function assertCategoryAssignable(
  db: CategoryReader,
  categoryId: string,
  kind: AssetKind,
): Promise<void> {
  const category = await db.category.findUnique({ where: { id: categoryId }, select: { kind: true } });
  if (!category) {
    throw appError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      ErrorCode.VALIDATION_FAILED,
      `Category ${categoryId} does not exist.`,
    );
  }
  if (category.kind !== kind) {
    throw appError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      ErrorCode.VALIDATION_FAILED,
      `Category ${categoryId} is for ${category.kind}, not ${kind}.`,
    );
  }
}
