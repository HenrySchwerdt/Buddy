export type TidepoolErrorCode =
  /** No signed-in session. */
  | 'session-missing'
  /** The server rejected the credentials and the refresh token no longer works: the user must sign in again. */
  | 'not-authenticated'
  | 'not-authorized'
  | 'not-found'
  | 'malformed'
  | 'network'
  | 'unexpected'
  | 'login-cancelled'
  /** Discovery (`/info` or `.well-known/openid-configuration`) failed or lacked a required field. */
  | 'auth-config'
  /** The authorization server answered the login with an error, or the callback was unusable. */
  | 'auth-error'
  | 'configuration';

/** Every failure of this package. Messages never contain tokens or request bodies. */
export class TidepoolError extends Error {
  readonly code: TidepoolErrorCode;
  readonly status?: number;
  constructor(code: TidepoolErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'TidepoolError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** Throw this from `openAuthSession` when the user closes the browser sheet. */
export class TidepoolLoginCancelledError extends TidepoolError {
  constructor() {
    super('login-cancelled', 'Tidepool login was cancelled');
    this.name = 'TidepoolLoginCancelledError';
  }
}

export const isTidepoolError = (e: unknown): e is TidepoolError => e instanceof TidepoolError;

/** True when the user has to sign in again before anything else can succeed. */
export const needsReauthentication = (e: unknown): boolean =>
  isTidepoolError(e) && (e.code === 'not-authenticated' || e.code === 'session-missing');

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
