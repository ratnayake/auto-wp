export interface TopoResult<T> {
  /** Items with all in-set dependencies placed before them; ties broken by `cmp`. */
  ordered: T[];
  /** Items on a dependency cycle, or downstream of one. */
  cyclic: T[];
}

/**
 * Kahn's algorithm. Dependencies that name items outside `items` are ignored. Deterministic for a
 * given input order and comparator.
 */
export function topoSort<T>(
  items: readonly T[],
  key: (t: T) => string,
  deps: (t: T) => readonly string[],
  cmp: (a: T, b: T) => number,
): TopoResult<T> {
  const keys = new Set(items.map(key));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, T[]>();
  for (const t of items) {
    const k = key(t);
    let count = 0;
    for (const d of new Set(deps(t))) {
      if (d === k || !keys.has(d)) continue;
      count++;
      dependents.set(d, [...(dependents.get(d) ?? []), t]);
    }
    indegree.set(k, count);
  }

  const ready = items.filter((t) => indegree.get(key(t)) === 0);
  const ordered: T[] = [];
  const placed = new Set<string>();
  while (ready.length > 0) {
    ready.sort(cmp);
    const next = ready.shift() as T;
    ordered.push(next);
    placed.add(key(next));
    for (const dependent of dependents.get(key(next)) ?? []) {
      const remaining = (indegree.get(key(dependent)) ?? 0) - 1;
      indegree.set(key(dependent), remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }
  return { ordered, cyclic: items.filter((t) => !placed.has(key(t))) };
}
