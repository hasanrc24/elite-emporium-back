import { AppError } from '../../lib/errors.js';

export const validate = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source]);
  if (!result.success) {
    const fieldErrors = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || '_form';
      fieldErrors[key] ||= [];
      fieldErrors[key].push(issue.message);
    }
    return next(AppError.unprocessable('VALIDATION_ERROR', 'Check the highlighted fields.', fieldErrors));
  }
  req[source] = result.data;
  next();
};
