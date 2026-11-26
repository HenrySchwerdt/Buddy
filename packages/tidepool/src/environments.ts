import { formEncode } from './encoding';
import { TidepoolError } from './errors';

/**
 * A Tidepool API environment (TidepoolKit `TEnvironment`). Requests use HTTPS only when the
 * port is 443; any other port is plain HTTP, which is only meant for a local development server.
 */
export interface TidepoolEnvironment {
  readonly host: string;
  readonly port: number;
}

/** TidepoolKit's built-in (and DNS-independent) production environment. */
export const PRODUCTION_ENVIRONMENT: TidepoolEnvironment = { host: 'app.tidepool.org', port: 443 };

/**
 * Tidepool's public integration environment. TidepoolKit discovers further environments from the
 * DNS SRV records of `environments-srv.tidepool.org`, which React Native cannot query, so any
 * other server has to be given as an explicit `{ host, port }`.
 */
export const INTEGRATION_ENVIRONMENT: TidepoolEnvironment = { host: 'external.integration.tidepool.org', port: 443 };

export const TIDEPOOL_ENVIRONMENTS = {
  production: PRODUCTION_ENVIRONMENT,
  integration: INTEGRATION_ENVIRONMENT,
} as const;

export type TidepoolEnvironmentName = keyof typeof TIDEPOOL_ENVIRONMENTS;

export const describeEnvironment = (env: TidepoolEnvironment): string => `${env.host}:${env.port}`;

export const sameEnvironment = (a: TidepoolEnvironment, b: TidepoolEnvironment): boolean => a.host === b.host && a.port === b.port;

export function isValidEnvironment(v: unknown): v is TidepoolEnvironment {
  if (typeof v !== 'object' || v === null) return false;
  const { host, port } = v as Record<string, unknown>;
  return typeof host === 'string' && /^[A-Za-z0-9.-]+$/.test(host) && typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536;
}

/** Same URL rules as `TEnvironment.url(path:queryItems:)`. */
export function environmentUrl(env: TidepoolEnvironment, path: string, query?: Readonly<Record<string, string | undefined>>): string {
  if (!isValidEnvironment(env)) throw new TidepoolError('configuration', 'Invalid Tidepool environment');
  const scheme = env.port === 443 ? 'https' : 'http';
  const authority = env.port === 443 || env.port === 80 ? env.host : `${env.host}:${env.port}`;
  const p = path.startsWith('/') ? path : `/${path}`;
  const qs = query ? formEncode(query) : '';
  return `${scheme}://${authority}${p}${qs ? `?${qs}` : ''}`;
}
