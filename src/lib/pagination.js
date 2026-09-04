export function pagination(query, maximum = 100) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(maximum, Math.max(1, Number(query.pageSize) || 20));
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

export function pageEnvelope(result, page, pageSize) {
  return {
    data: result.rows,
    meta: { page, pageSize, total: result.count, pageCount: Math.ceil(result.count / pageSize) },
  };
}
