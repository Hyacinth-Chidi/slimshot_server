import { UnprocessableEntityException } from '@nestjs/common';

import { AssetKind } from '../../generated/prisma/enums';
import { AdminCategoriesController } from './admin-categories.controller';

function build() {
  const categories = {
    tree: jest.fn(async () => []),
  };
  return { ctl: new AdminCategoriesController(categories as never), categories };
}

describe('AdminCategoriesController.tree', () => {
  it('passes a known kind through', async () => {
    const { ctl, categories } = build();
    await ctl.tree(AssetKind.audio);
    expect(categories.tree).toHaveBeenCalledWith('audio');
  });

  // `@Query('kind') kind: AssetKind` looks like validation but the annotation
  // erases at runtime, and AssetKind is a const object rather than a TS enum,
  // so nothing checked it. An empty `kind` - what a dashboard sends on its
  // first paint before a filter is chosen - reached Prisma and returned a 500
  // with a stack trace for an ordinary client mistake.
  it('rejects an empty kind with a 422 instead of reaching Prisma', async () => {
    const { ctl, categories } = build();
    await expect(ctl.tree('' as AssetKind)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(categories.tree).not.toHaveBeenCalled();
  });

  it('rejects a bogus kind with a 422', async () => {
    const { ctl, categories } = build();
    await expect(ctl.tree('spreadsheet' as AssetKind)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(categories.tree).not.toHaveBeenCalled();
  });

  it('rejects a missing kind with a 422', async () => {
    const { ctl } = build();
    await expect(ctl.tree(undefined as unknown as AssetKind)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('names the accepted kinds so the caller can correct the request', async () => {
    const { ctl } = build();
    await expect(ctl.tree('spreadsheet' as AssetKind)).rejects.toThrow(/audio/);
  });
});
