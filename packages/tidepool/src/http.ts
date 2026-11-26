import { parseJson } from './encoding';
import { TidepoolError, errorText } from './errors';

export interface HttpResult {
  readonly status: number;
  readonly ok: boolean;
  /** Parsed JSON body, or `null` when the body is empty or not JSON. */
  readonly json: unknown;
}

/** One request through the injected `fetch`. Transport failures become `TidepoolError('network')`. */
export async function http(fetchFn: typeof fetch, url: string, init: RequestInit): Promise<HttpResult> {
  let res: Response;
  try {
    res = await fetchFn(url, init);
  } catch (e) {
    throw new TidepoolError('network', `Network error: ${errorText(e)}`);
  }
  let text = '';
  try {
    text = await res.text();
  } catch {
    // An unreadable body is treated like an empty one; the status still tells what happened.
  }
  return { status: res.status, ok: res.status >= 200 && res.status <= 299, json: text ? parseJson(text) : null };
}

const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } as const;

export const postForm = (fetchFn: typeof fetch, url: string, body: string): Promise<HttpResult> =>
  http(fetchFn, url, { method: 'POST', headers: { ...FORM_HEADERS }, body });
