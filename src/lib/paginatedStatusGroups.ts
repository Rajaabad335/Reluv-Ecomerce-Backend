export const DEFAULT_LIST_PAGE_SIZE = 10;
export const MAX_LIST_PAGE_SIZE = 100;

export type StatusGroup<TStatus extends string = string> = {
  key: TStatus;
  total: number;
};

export function parseListPagination(pageValue: unknown, pageSizeValue: unknown) {
  const parsedPage = Number(pageValue);
  const parsedPageSize = Number(pageSizeValue);
  const page = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const pageSize = Number.isInteger(parsedPageSize) && parsedPageSize > 0
    ? Math.min(parsedPageSize, MAX_LIST_PAGE_SIZE)
    : DEFAULT_LIST_PAGE_SIZE;

  return { page, pageSize };
}

/**
 * Applies page-number pagination across a fixed, already-prioritized sequence
 * of status groups. Only records intersecting the requested page are fetched.
 */
export async function fetchStatusGroupPage<TItem, TStatus extends string>(params: {
  groups: StatusGroup<TStatus>[];
  page: number;
  pageSize: number;
  fetchGroup: (status: TStatus, start: number, limit: number) => Promise<TItem[] | TItem>;
}) {
  const total = params.groups.reduce((sum, group) => sum + group.total, 0);
  const pageCount = Math.max(1, Math.ceil(total / params.pageSize));
  const page = Math.min(params.page, pageCount);
  const rangeStart = (page - 1) * params.pageSize;
  const rangeEnd = Math.min(rangeStart + params.pageSize, total);

  let cursor = 0;
  const groupRanges = params.groups.map((group) => {
    const groupStart = cursor;
    cursor += group.total;
    return { group, groupStart, groupEnd: cursor };
  });
  const data = await Promise.all(groupRanges.map(async ({ group, groupStart, groupEnd }) => {
    const overlapStart = Math.max(rangeStart, groupStart);
    const overlapEnd = Math.min(rangeEnd, groupEnd);
    const start = overlapStart - groupStart;

    if (overlapStart >= overlapEnd) return [] as TItem[];
    const result = await params.fetchGroup(group.key, start, overlapEnd - overlapStart);
    return Array.isArray(result) ? result : [result];
  }));

  return {
    data: data.flat(),
    pagination: { page, pageSize: params.pageSize, pageCount, total },
  };
}
