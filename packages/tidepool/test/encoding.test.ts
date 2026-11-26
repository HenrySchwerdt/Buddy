import { describe, expect, it } from 'vitest';
import { base64Url, challengeForVerifier, createPkce, formEncode, md5Hex, parseQuery } from '../src';
import { RFC_BYTES, RFC_CHALLENGE, RFC_VERIFIER, sequenceRandom } from './fixtures';
import { environmentUrl, PRODUCTION_ENVIRONMENT } from '../src';

describe('base64Url', () => {
  it('encodes without padding for every remainder length', () => {
    expect(base64Url(new Uint8Array([]))).toBe('');
    expect(base64Url(new Uint8Array([0x66]))).toBe('Zg');
    expect(base64Url(new Uint8Array([0x66, 0x6f]))).toBe('Zm8');
    expect(base64Url(new Uint8Array([0x66, 0x6f, 0x6f]))).toBe('Zm9v');
  });
  it('uses the URL-safe alphabet', () => {
    expect(base64Url(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('-__-');
  });
});

describe('md5Hex', () => {
  it('matches the RFC 1321 vectors', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });
});

describe('PKCE', () => {
  it('derives the RFC 7636 S256 challenge', () => {
    expect(base64Url(RFC_BYTES)).toBe(RFC_VERIFIER);
    expect(challengeForVerifier(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });
  it('builds a 43 character verifier from 32 random bytes like TidepoolKit', () => {
    const pkce = createPkce(sequenceRandom(RFC_BYTES));
    expect(pkce).toEqual({ verifier: RFC_VERIFIER, challenge: RFC_CHALLENGE });
    expect(pkce.verifier).toHaveLength(43);
  });
  it('produces different verifiers from the default random source', () => {
    expect(createPkce().verifier).not.toBe(createPkce().verifier);
  });
});

describe('query helpers', () => {
  it('form-encodes and skips undefined', () => {
    expect(formEncode({ a: 'b c', d: 'x&y=z', e: undefined })).toBe('a=b%20c&d=x%26y%3Dz');
  });
  it('parses custom-scheme callbacks, plus signs and fragments', () => {
    expect(parseQuery('buddy://tidepool-auth?code=abc%2F1&state=s+t&flag#frag=1')).toEqual({ code: 'abc/1', state: 's t', flag: '' });
    expect(parseQuery('buddy://tidepool-auth')).toEqual({});
    expect(parseQuery('buddy://x?bad=%E0%A4%A&ok=1')).toEqual({ ok: '1' });
  });
});

describe('environmentUrl', () => {
  it('uses https only on 443, like TEnvironment', () => {
    expect(environmentUrl(PRODUCTION_ENVIRONMENT, '/info')).toBe('https://app.tidepool.org/info');
    expect(environmentUrl({ host: 'localhost', port: 8009 }, 'auth/user')).toBe('http://localhost:8009/auth/user');
    expect(environmentUrl({ host: 'dev.example.test', port: 80 }, '/x', { a: '1 2', b: undefined })).toBe('http://dev.example.test/x?a=1%202');
  });
  it('rejects a malformed environment', () => {
    expect(() => environmentUrl({ host: 'bad host/', port: 443 }, '/')).toThrow(/Invalid Tidepool environment/);
  });
});
