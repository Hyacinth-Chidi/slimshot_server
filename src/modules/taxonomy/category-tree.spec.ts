import { subtreeIds } from './category-tree';

const rows = [
  { id: 'root', parentId: null, isActive: true },
  { id: 'ui', parentId: 'root', isActive: true },
  { id: 'ui-clicks', parentId: 'ui', isActive: true },
  { id: 'hidden', parentId: 'root', isActive: false },
  { id: 'under-hidden', parentId: 'hidden', isActive: true },
  { id: 'other-root', parentId: null, isActive: true },
];

describe('subtreeIds', () => {
  it('returns the node and every descendant', () => {
    expect(subtreeIds(rows, 'root').sort()).toEqual(['hidden', 'root', 'ui', 'ui-clicks', 'under-hidden']);
  });

  it('skips inactive nodes and everything under them when asked', () => {
    expect(subtreeIds(rows, 'root', { activeOnly: true }).sort()).toEqual(['root', 'ui', 'ui-clicks']);
  });

  it('returns nothing for an inactive root when only active nodes count', () => {
    expect(subtreeIds(rows, 'hidden', { activeOnly: true })).toEqual([]);
  });

  it('returns nothing for an unknown id', () => {
    expect(subtreeIds(rows, 'nope')).toEqual([]);
  });

  it('survives a cycle without looping forever', () => {
    const cyclic = [
      { id: 'a', parentId: 'b', isActive: true },
      { id: 'b', parentId: 'a', isActive: true },
    ];
    expect(subtreeIds(cyclic, 'a').sort()).toEqual(['a', 'b']);
  });
});
