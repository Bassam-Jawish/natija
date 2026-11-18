import { describe, expect, it } from 'vitest';
import { anon, getApp, login } from './helpers';

describe('sign-in and sessions', () => {
  it('signs in with a demo account and returns the lab and permissions', async () => {
    const c = await login('yasmin', 'reception');
    expect(c.me.permissions).toContain('orders.create');
    expect(c.me.permissions).not.toContain('results.validate');
    const me = await c.get('/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().lab.code).toBe('yasmin');
  });

  it('rejects a wrong password with a generic error', async () => {
    const res = await anon('POST', '/auth/login', { labCode: 'yasmin', username: 'doctor', password: 'nope' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('invalid_credentials');
  });

  it('gives the same answer for an unknown user as for a wrong password', async () => {
    const res = await anon('POST', '/auth/login', { labCode: 'yasmin', username: 'no.such.user', password: 'x' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('invalid_credentials');
  });

  it('requires a session for protected routes', async () => {
    const res = await anon('GET', '/auth/me');
    expect(res.statusCode).toBe(401);
  });

  it('refuses state-changing requests without the CSRF token', async () => {
    const c = await login('yasmin', 'owner');
    const app = await getApp();
    const sid = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { labCode: 'yasmin', username: 'owner', password: 'Natija@2026' } })).cookies.find(
      (x) => x.name === 'natija_sid',
    )!.value;
    const res = await app.inject({ method: 'POST', url: '/api/v1/notifications/read-all', cookies: { natija_sid: sid } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('csrf');
    const ok = await c.post('/notifications/read-all');
    expect(ok.statusCode).toBe(200);
  });

  it('locks an account after five wrong passwords', async () => {
    for (let i = 0; i < 5; i++) await anon('POST', '/auth/login', { labCode: 'citadel', username: 'accountant', password: `bad-${i}` });
    const res = await anon('POST', '/auth/login', { labCode: 'citadel', username: 'accountant', password: 'Natija@2026' });
    expect(res.statusCode).toBe(423);
    expect(res.json().code).toBe('account_locked');
  });

  it('signs out and invalidates the session', async () => {
    const c = await login('orontes', 'tech');
    expect((await c.post('/auth/logout')).statusCode).toBe(200);
    expect((await c.get('/auth/me')).statusCode).toBe(401);
  });
});
