import { describe, expect, it } from 'vitest';
import { renderTemplate } from '../../src/jobs/job-runner.js';

describe('notification template rendering', () => {
  it('renders only declared variables', () => {
    const rendered = renderTemplate({ subject: 'Order {{reference}}', body: 'Hello {{name}}', variables: ['reference', 'name'] }, { reference: 'EE-123', name: 'Amina' });
    expect(rendered).toEqual({ subject: 'Order EE-123', body: 'Hello Amina' });
  });

  it('rejects missing and undeclared variables', () => {
    expect(() => renderTemplate({ subject: null, body: '{{secret}}', variables: [] }, { secret: 'value' })).toThrow(/disallowed/);
    expect(() => renderTemplate({ subject: null, body: '{{name}}', variables: ['name'] }, {})).toThrow(/Missing/);
  });
});
