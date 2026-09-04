import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app/create-app.js';

describe('health endpoint', () => {
  it('registers the liveness route with the standard response envelope', () => {
    const app = createApp();
    const route = app.router.stack.find((layer) => layer.route?.path === '/api/v1/health/live');
    expect(route).toBeTruthy();

    let body;
    route.route.stack[0].handle(
      { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
      { json(value) { body = value; return this; } },
    );

    expect(body).toEqual({
      data: { status: 'ok' },
      meta: null,
      requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
  });
});
