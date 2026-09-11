type PageQuery = { page?: unknown; pageSize?: unknown };

export function pagination(query: PageQuery, maximum = 100) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(maximum, Math.max(1, Number(query.pageSize) || 20));
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

export function pageEnvelope<T>(
  result: { rows: T[]; count: number },
  page: number,
  pageSize: number,
) {
  return {
    data: result.rows,
    meta: {
      page,
      pageSize,
      total: result.count,
      pageCount: Math.ceil(result.count / pageSize),
    },
  };
}
