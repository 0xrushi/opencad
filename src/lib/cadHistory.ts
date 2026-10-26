// Version history for a CAD conversation. Messages form a tree and the
// conversation's leaf pointer picks the active branch, so undo and redo only
// move that pointer between saved model versions; nothing is deleted.

export type HistoryRow = {
  id: string;
  parent_message_id: string | null;
  role: string;
  created_at: string;
};

/** Rows from the root down to `leafId`, following parent links. */
export function branchTo<T extends HistoryRow>(rows: T[], leafId: string | null): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const path: T[] = [];
  const seen = new Set<string>();
  let id = leafId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const row = byId.get(id);
    if (!row) break;
    path.push(row);
    id = row.parent_message_id;
  }
  return path.reverse();
}

/**
 * The model version to return to: the previous version on this branch, or, if
 * the branch ends in a request that never produced one, the latest version.
 */
export function undoTarget<T extends HistoryRow>(
  rows: T[],
  leafId: string | null,
  isVersion: (row: T) => boolean,
): T | null {
  const branch = branchTo(rows, leafId);
  const versions = branch.filter((row) => row.role === 'assistant' && isVersion(row));
  if (versions.length === 0) return null;
  const last = branch[branch.length - 1];
  if (last.role === 'user') return versions[versions.length - 1];
  return versions.length >= 2 ? versions[versions.length - 2] : null;
}

/** The nearest later version below the leaf, preferring the newest branch. */
export function redoTarget<T extends HistoryRow>(
  rows: T[],
  leafId: string | null,
  isVersion: (row: T) => boolean,
): T | null {
  if (!leafId) return null;
  const children = rows
    .filter((row) => row.parent_message_id === leafId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  for (const child of children) {
    if (child.role === 'assistant' && isVersion(child)) return child;
    const deeper = redoTarget(rows, child.id, isVersion);
    if (deeper) return deeper;
  }
  return null;
}
