export type QueryPage<T> = { data: T[] | null; error: unknown; count?: number | null };

/** Read every authorized row even when the server caps pages below the requested size. */
export async function readAllRows<T>(read: (from: number, to: number) => PromiseLike<QueryPage<T>>, pageSize = 1000): Promise<T[]> {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('Invalid page size');
  const rows: T[] = [];
  let expected: number | undefined;
  for (;;) {
    const page = await read(rows.length, rows.length + pageSize - 1);
    if (page.error || !Array.isArray(page.data)) throw new Error('Query failed');
    if (page.count !== undefined && page.count !== null) {
      if (!Number.isSafeInteger(page.count) || page.count < 0 || (expected !== undefined && expected !== page.count)) throw new Error('Records changed during pagination');
      expected = page.count;
    }
    rows.push(...page.data);
    if (expected !== undefined) {
      if (rows.length > expected) throw new Error('Record count mismatch');
      if (rows.length === expected) return rows;
      if (page.data.length === 0) throw new Error('Pagination ended before the expected count');
    } else if (page.data.length < pageSize) return rows;
  }
}
