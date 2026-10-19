/** Presentation only: callers supply the latest validated snapshot, not tool history. */
export interface TodoDisplayItem {
  readonly id: number;
  readonly text: string;
  readonly completed: boolean;
  readonly completedAt?: number;
}

export interface TodoDisplayRow extends TodoDisplayItem {
  /** Prefix before ellipsizing so the tool ID remains visible. */
  readonly label: string;
  /** Queue position only. The todo model has no running/in-progress state. */
  readonly isNextPending: boolean;
}

export interface TodoDisplayCounts {
  total: number;
  pending: number;
  completed: number;
}

export interface TodoDisplay {
  rows: TodoDisplayRow[];
  /** Counts cover ALL supplied items, not just visible rows. If the producer
   * already truncated them, these are subset counts, not session totals. */
  counts: TodoDisplayCounts;
  hidden: { pending: number; completed: number };
}

/** Pending tasks get available slots in ascending numeric ID order. If a slot
 * remains, include at most one completion: the highest numeric ID, regardless
 * of completion timestamps or input order. Sort ALL selected rows by numeric ID.
 *
 * No caching, clock, mutation, sanitization, or tool-state reconstruction. A
 * bounded transport must select from the full validated list BEFORE truncating
 * and carry full counts separately; the renderer cannot recover missing tasks.
 */
export function selectTodoDisplay(items: readonly TodoDisplayItem[], maxRows: number): TodoDisplay {
  if (!Number.isSafeInteger(maxRows) || maxRows < 0) {
    throw new RangeError('maxRows must be a nonnegative safe integer');
  }

  const pending = items.filter(item => !item.completed).sort((a, b) => a.id - b.id);
  const completed = items.filter(item => item.completed).sort((a, b) => b.id - a.id);
  const shownPending = pending.slice(0, maxRows);
  const shownCompleted = shownPending.length < maxRows ? completed.slice(0, 1) : [];

  const selected = [...shownPending, ...shownCompleted].sort((a, b) => a.id - b.id);
  return {
    rows: selected.map(item => ({
      id: item.id,
      text: item.text,
      completed: item.completed,
      ...(item.completedAt === undefined ? {} : { completedAt: item.completedAt }),
      label: `#${item.id} ${item.text}`,
      isNextPending: item === shownPending[0],
    })),
    counts: { total: items.length, pending: pending.length, completed: completed.length },
    hidden: { pending: pending.length - shownPending.length, completed: completed.length - shownCompleted.length },
  };
}
