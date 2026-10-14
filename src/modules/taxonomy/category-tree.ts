export interface TreeRow {
  id: string;
  parentId: string | null;
  isActive: boolean;
}

/**
 * The ids of a category and everything under it, root first. With
 * `activeOnly`, a hidden category hides its whole subtree (the app never shows
 * sounds filed under a hidden category), and a hidden root gives [].
 */
export function subtreeIds(
  rows: TreeRow[],
  rootId: string,
  opts: { activeOnly?: boolean } = {},
): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map<string, TreeRow[]>();
  for (const r of rows) {
    if (r.parentId === null) continue;
    const list = children.get(r.parentId) ?? [];
    list.push(r);
    children.set(r.parentId, list);
  }

  const root = byId.get(rootId);
  if (!root || (opts.activeOnly && !root.isActive)) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node.id);
    for (const child of children.get(node.id) ?? []) {
      if (opts.activeOnly && !child.isActive) continue;
      stack.push(child);
    }
  }
  return out;
}
