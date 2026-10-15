import { assertCategoryAssignable } from './category-rules';

const reader = (row: unknown) => ({ category: { findUnique: jest.fn(async () => row) } });

describe('assertCategoryAssignable', () => {
  it('accepts a category of the same kind, hidden or not', async () => {
    await expect(
      assertCategoryAssignable(reader({ kind: 'audio', isActive: false }) as never, 'c1', 'audio'),
    ).resolves.toBeUndefined();
  });

  it('refuses a category of another kind with 422', async () => {
    await expect(
      assertCategoryAssignable(reader({ kind: 'font', isActive: true }) as never, 'c1', 'audio'),
    ).rejects.toMatchObject({
      status: 422,
      response: { code: 'VALIDATION_FAILED', message: 'Category c1 is for font, not audio.' },
    });
  });

  it('refuses an unknown category with 422', async () => {
    await expect(assertCategoryAssignable(reader(null) as never, 'nope', 'audio')).rejects.toMatchObject({
      status: 422,
      response: { code: 'VALIDATION_FAILED', message: 'Category nope does not exist.' },
    });
  });
});
