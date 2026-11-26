import { silentLogger, type Logger } from '@buddy/core';
import { isRecord } from './encoding';
import { SESSION_TOKEN_HEADER, TRACE_SESSION_HEADER, type TidepoolAuth, type TidepoolSession } from './auth';
import { environmentUrl } from './environments';
import { TidepoolError, type TidepoolErrorCode } from './errors';
import { http, type HttpResult } from './http';
import type { TidepoolDatum } from './types';

/** Body of `POST /v1/users/{id}/data_sets` as TidepoolService creates it. */
export interface TidepoolDataSetRequest {
  readonly type: 'upload';
  readonly dataSetType: 'continuous';
  readonly client: { readonly name: string; readonly version: string };
  readonly deduplicator: { readonly name: string };
  readonly deviceTags: readonly string[];
}

export interface TidepoolDataSet {
  readonly id?: string;
  readonly uploadId?: string;
  readonly client?: { readonly name?: string; readonly version?: string };
}

/** Selects datums to delete: by the `origin.id` the mapping assigned, or by Tidepool's own `id`. */
export type TidepoolSelector = { readonly origin: { readonly id: string } } | { readonly id: string };

/** The one deduplicator TidepoolService uses: data with an already known `origin.id` replaces the old datum. */
export const DEDUPLICATOR_DATASET_DELETE_ORIGIN = 'org.tidepool.deduplicator.dataset.delete.origin';
export const DATA_SET_DEVICE_TAGS = ['bgm', 'cgm', 'insulin-pump'] as const;

export interface TidepoolApi {
  listDataSets(filter: { readonly clientName?: string; readonly deleted?: boolean }): Promise<TidepoolDataSet[]>;
  createDataSet(request: TidepoolDataSetRequest): Promise<TidepoolDataSet>;
  createData(dataSetId: string, data: readonly TidepoolDatum[]): Promise<void>;
  deleteData(dataSetId: string, selectors: readonly TidepoolSelector[]): Promise<void>;
}

export interface TidepoolApiConfig {
  readonly auth: TidepoolAuth;
  readonly fetch: typeof fetch;
  readonly log?: Logger;
}

interface RequestOptions {
  readonly query?: Record<string, string | undefined>;
  readonly body?: unknown;
}

function codeForStatus(status: number): TidepoolErrorCode {
  switch (status) {
    case 400:
      return 'malformed';
    case 401:
      return 'not-authenticated';
    case 403:
      return 'not-authorized';
    case 404:
      return 'not-found';
    default:
      return 'unexpected';
  }
}

/** Short, token-free description of an error response (`reason`, or the first validation details). */
function describeFailure(res: HttpResult): string {
  const j = res.json;
  if (isRecord(j) && typeof j.reason === 'string') return `${j.reason} (HTTP ${res.status})`;
  if (isRecord(j) && Array.isArray(j.errors)) {
    const details = j.errors
      .map((e) => (isRecord(e) ? (typeof e.detail === 'string' ? e.detail : typeof e.title === 'string' ? e.title : '') : ''))
      .filter(Boolean)
      .slice(0, 3);
    if (details.length) return `${details.join('; ')} (HTTP ${res.status})`;
  }
  return `HTTP ${res.status}`;
}

export function createTidepoolApi(config: TidepoolApiConfig): TidepoolApi {
  const log = config.log ?? silentLogger;

  function send(session: TidepoolSession, method: string, path: string, options: RequestOptions): Promise<HttpResult> {
    const headers: Record<string, string> = { Accept: 'application/json', [SESSION_TOKEN_HEADER]: session.accessToken };
    if (session.traceId) headers[TRACE_SESSION_HEADER] = session.traceId;
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      init.body = JSON.stringify(options.body);
    }
    return http(config.fetch, environmentUrl(session.environment, path, options.query), init);
  }

  /** Sends with the current session; one 401 triggers one refresh and one retry (like TidepoolKit). */
  async function request(method: string, path: (userId: string) => string, options: RequestOptions = {}): Promise<HttpResult> {
    const session = await config.auth.getValidSession();
    let res = await send(session, method, path(session.userId), options);
    if (res.status === 401) {
      log.info('Tidepool: request rejected, refreshing session');
      const fresh = await config.auth.refresh({ staleAccessToken: session.accessToken });
      res = await send(fresh, method, path(fresh.userId), options);
    }
    if (!res.ok) throw new TidepoolError(codeForStatus(res.status), `Tidepool ${method} request failed: ${describeFailure(res)}`, res.status);
    return res;
  }

  const dataSetOf = (v: unknown): TidepoolDataSet | null => {
    if (!isRecord(v)) return null;
    const out: { id?: string; uploadId?: string; client?: { name?: string; version?: string } } = {};
    if (typeof v.id === 'string') out.id = v.id;
    if (typeof v.uploadId === 'string') out.uploadId = v.uploadId;
    if (isRecord(v.client)) {
      out.client = {
        ...(typeof v.client.name === 'string' ? { name: v.client.name } : {}),
        ...(typeof v.client.version === 'string' ? { version: v.client.version } : {}),
      };
    }
    return out;
  };

  return {
    async listDataSets(filter) {
      const res = await request('GET', (u) => `/v1/users/${u}/data_sets`, {
        query: { 'client.name': filter.clientName, deleted: filter.deleted === undefined ? undefined : String(filter.deleted) },
      });
      const list = Array.isArray(res.json) ? res.json : isRecord(res.json) && Array.isArray(res.json.data) ? res.json.data : null;
      if (!list) throw new TidepoolError('unexpected', 'Tidepool data set list was malformed');
      return list.map(dataSetOf).filter((d): d is TidepoolDataSet => d !== null);
    },
    async createDataSet(requestBody) {
      const res = await request('POST', (u) => `/v1/users/${u}/data_sets`, { body: requestBody });
      const created = dataSetOf(isRecord(res.json) ? res.json.data : null);
      if (!created) throw new TidepoolError('unexpected', 'Tidepool data set response was malformed');
      return created;
    },
    async createData(dataSetId, data) {
      if (data.length === 0) return;
      await request('POST', () => `/v1/data_sets/${encodeURIComponent(dataSetId)}/data`, { body: data });
    },
    async deleteData(dataSetId, selectors) {
      if (selectors.length === 0) return;
      await request('DELETE', () => `/v1/data_sets/${encodeURIComponent(dataSetId)}/data`, { body: selectors });
    },
  };
}
