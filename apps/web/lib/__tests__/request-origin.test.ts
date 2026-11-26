import { describe, expect, it } from 'vitest';
import { allowedExtraOrigins, isAllowedOrigin, originDenied } from '../request-origin';

const req = (headers: Record<string, string>) => new Request('http://127.0.0.1:3000/api/x', { method: 'POST', headers });

describe('isAllowedOrigin', () => {
  it('allows loopback hosts on any port', () => {
    for (const o of ['http://localhost:3000', 'http://127.0.0.1:4010', 'http://[::1]:3000', 'http://localhost', 'https://localhost:8443']) {
      expect(isAllowedOrigin(o, {})).toBe(true);
    }
  });
  it('refuses a rebinding host even when it would match the Host header', () => {
    expect(isAllowedOrigin('http://attacker.example:3000', {})).toBe(false);
    expect(isAllowedOrigin('http://localhost.attacker.example', {})).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1.attacker.example', {})).toBe(false);
    expect(isAllowedOrigin('null', {})).toBe(false);
  });
  it('allows only listed extra origins', () => {
    const env = { WORLD_ALLOWED_ORIGINS: 'https://canvas.example.com, http://lan.test:3000/ ,not a url' };
    expect(allowedExtraOrigins(env)).toEqual(['https://canvas.example.com', 'http://lan.test:3000']);
    expect(isAllowedOrigin('https://canvas.example.com', env)).toBe(true);
    expect(isAllowedOrigin('http://lan.test:3000', env)).toBe(true);
    expect(isAllowedOrigin('https://canvas.example.com:8443', env)).toBe(false);
    expect(isAllowedOrigin('https://other.example.com', env)).toBe(false);
  });
});

describe('originDenied', () => {
  it('denies a rebinding origin that matches the Host header', () => {
    const request = new Request('http://attacker.example:3000/api/x', {
      method: 'POST',
      headers: { host: 'attacker.example:3000', origin: 'http://attacker.example:3000' },
    });
    expect(originDenied(request, {})).toBe(true);
  });
  it('denies sec-fetch-site cross-site even from a loopback origin', () => {
    expect(originDenied(req({ origin: 'http://localhost:3000', 'sec-fetch-site': 'cross-site' }), {})).toBe(true);
  });
  it('allows loopback origins, same-origin and header-less requests', () => {
    expect(originDenied(req({ origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' }), {})).toBe(false);
    expect(originDenied(req({}), {})).toBe(false);
  });
  it('allows header-less non-browser clients but denies absent Origin with a non-same-origin sec-fetch-site', () => {
    expect(originDenied(req({ 'sec-fetch-site': 'none' }), {})).toBe(false);
    expect(originDenied(req({ 'sec-fetch-site': 'same-origin' }), {})).toBe(false);
    expect(originDenied(req({ 'sec-fetch-site': 'same-site' }), {})).toBe(true);
    expect(originDenied(req({ 'sec-fetch-site': 'cross-site' }), {})).toBe(true);
    expect(originDenied(req({ 'sec-fetch-site': 'bogus' }), {})).toBe(true);
  });
});
