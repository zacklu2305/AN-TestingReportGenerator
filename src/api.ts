import type {
  BaseApiResponse,
  BasicResponse,
  BuildReportResponse,
  GetPhotoResponse,
  ListResponse,
  LoginResponse,
  PhotoParams,
  ReportGetResponse,
  RequestTokenResponse,
  SavePhotoResponse,
  SaveResultsResponse,
  SavedResults,
  VerifyTokenResponse,
} from './types';

export const ENABLE_ANNOTATIONS = true;
export const REMEMBER_SESSION = true;
export const DISABLE_EMAIL_SUGGEST = true;
export const ENABLE_NEW_LIST = true;
export const ENABLE_BATCH = true;
export const ENABLE_SERVER_LOGOUT = true;

export const SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbzXU808up-gq_TQzWJFqA8riOsAHV0ye_CF94N3kFZ0LhVA3-wo_h5514_-2Y7Txdm42w/exec';

export const SESSION_STORAGE_KEY = 'tr_session';

export class ApiError extends Error {
  needLogin?: boolean;
  constructor(message: string, needLogin?: boolean) {
    super(message);
    this.name = 'ApiError';
    this.needLogin = needLogin;
  }
}

let activeSession = '';
let needLoginPromptHandler: (() => Promise<string | null>) | null = null;
let pendingReauthPromise: Promise<string | null> | null = null;

export function setActiveSession(session: string): void {
  activeSession = session;
}

function parseStoredSessionValue(raw: string | null): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { session?: unknown } | null;
    if (parsed && typeof parsed === 'object' && typeof parsed.session === 'string') {
      return parsed.session;
    }
  } catch {
    // Plain string session key from older storage format
  }
  return raw;
}

export function getStoredSession(): string {
  if (REMEMBER_SESSION) {
    try {
      const fromLocal = parseStoredSessionValue(
        localStorage.getItem(SESSION_STORAGE_KEY)
      );
      if (fromLocal) return fromLocal;
    } catch {
      // Fall back to sessionStorage when localStorage is blocked
    }
  }
  try {
    return parseStoredSessionValue(sessionStorage.getItem(SESSION_STORAGE_KEY));
  } catch {
    return '';
  }
}

export function saveStoredSession(session: string): void {
  if (!session) {
    clearStoredSession();
    return;
  }

  if (REMEMBER_SESSION) {
    const payload = JSON.stringify({ session, savedAt: Date.now() });
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, payload);
      return;
    } catch {
      // localStorage blocked (e.g. private mode): fall back to sessionStorage
    }
    try {
      sessionStorage.setItem(SESSION_STORAGE_KEY, payload);
    } catch {
      // Both storages blocked: keep in memory only
    }
    return;
  }

  // When REMEMBER_SESSION is false: sessionStorage + memory only
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, session);
  } catch {
    // Ignore storage errors
  }
}

export function clearStoredSession(): void {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function registerNeedLoginHandler(
  handler: (() => Promise<string | null>) | null
): void {
  needLoginPromptHandler = handler;
}

async function requestReauth(): Promise<string | null> {
  if (!needLoginPromptHandler) return null;
  if (!pendingReauthPromise) {
    pendingReauthPromise = needLoginPromptHandler().finally(() => {
      pendingReauthPromise = null;
    });
  }
  return pendingReauthPromise;
}

async function rawFetch<T extends BaseApiResponse>(
  session: string,
  action: string,
  fields: Record<string, unknown>
): Promise<T> {
  // Log action name and payload keys only; never log session or token values
  const payloadKeys = Object.keys(fields).filter(
    (key) => key !== 'session' && fields[key] !== undefined
  );
  console.log('[Testing Report API]', action, payloadKeys);

  let response: Response;
  try {
    response = await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ session, action, ...fields }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Network request failed';
    throw new ApiError(`Network error: ${msg}`);
  }

  let json: T;
  try {
    json = (await response.json()) as T;
  } catch {
    throw new ApiError(`Invalid server response (HTTP ${response.status}).`);
  }

  return json;
}

async function apiCall<T extends BaseApiResponse>(
  session: string,
  action: string,
  fields: Record<string, unknown> = {},
  allowReauthRetry = true
): Promise<T> {
  const effectiveSession = activeSession || session;
  const json = await rawFetch<T>(effectiveSession, action, fields);

  if (json && json.needLogin === true) {
    clearStoredSession();
    activeSession = '';
    if (allowReauthRetry && needLoginPromptHandler) {
      const nextSession = await requestReauth();
      if (nextSession) {
        const retryJson = await rawFetch<T>(nextSession, action, fields);
        if (retryJson && retryJson.status === 'success') {
          return retryJson;
        }
        throw new ApiError(
          retryJson?.message || 'Request failed after login.',
          retryJson?.needLogin
        );
      }
    }
    throw new ApiError(
      json.message || 'Session expired. Please log in again.',
      true
    );
  }

  if (!json || json.status !== 'success') {
    throw new ApiError(json?.message || 'Request failed. Please try again.');
  }

  return json;
}

export function apiRequestToken(email: string): Promise<RequestTokenResponse> {
  return apiCall<RequestTokenResponse>('', 'requestToken', { email }, false);
}

export function apiVerifyToken(
  email: string,
  token: string
): Promise<VerifyTokenResponse> {
  return apiCall<VerifyTokenResponse>(
    '',
    'verifyToken',
    { email, token },
    false
  );
}

export function apiLogin(session: string): Promise<LoginResponse> {
  return apiCall<LoginResponse>(session, 'login', {});
}

export async function apiLogout(session: string): Promise<void> {
  const effectiveSession = activeSession || session;
  if (!effectiveSession) return;

  // Log action name and payload keys only; never log session key
  console.log('[Testing Report API]', 'logout', []);

  const controller =
    typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timerId: number | undefined;

  const timeoutPromise = new Promise<void>((resolve) => {
    timerId = window.setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // Ignore abort errors
      }
      resolve();
    }, 3000);
  });

  const requestPromise = (async () => {
    try {
      const response = await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ session: effectiveSession, action: 'logout' }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      await response.json().catch(() => null);
    } catch {
      // Ignore network, abort, or JSON errors; never block logout
    }
  })();

  await Promise.race([requestPromise, timeoutPromise]);
  if (timerId !== undefined) {
    window.clearTimeout(timerId);
  }
}

export function apiList(session: string, q: string): Promise<ListResponse> {
  return apiCall<ListResponse>(session, 'list', { q });
}

export function apiGetReport(
  session: string,
  reportNo: string
): Promise<ReportGetResponse> {
  return apiCall<ReportGetResponse>(session, 'get', { reportNo });
}

export function apiSaveResults(
  session: string,
  reportNo: string,
  results: SavedResults
): Promise<SaveResultsResponse> {
  return apiCall<SaveResultsResponse>(session, 'saveResults', {
    reportNo,
    results,
  });
}

export function apiSavePhoto(
  session: string,
  payload: {
    reportNo: string;
    slot: string;
    photoId?: string;
    original?: string;
    edited: string;
    params: PhotoParams;
  }
): Promise<SavePhotoResponse> {
  const fields: Record<string, unknown> = {
    reportNo: payload.reportNo,
    slot: payload.slot,
    edited: payload.edited,
    params: payload.params,
  };
  if (payload.photoId !== undefined) {
    fields.photoId = payload.photoId;
  }
  if (payload.original !== undefined) {
    fields.original = payload.original;
  }
  return apiCall<SavePhotoResponse>(session, 'savePhoto', fields);
}

export function apiDeletePhoto(
  session: string,
  photoId: string
): Promise<BasicResponse> {
  return apiCall<BasicResponse>(session, 'deletePhoto', { photoId });
}

export function apiReorderPhotos(
  session: string,
  reportNo: string,
  slot: string,
  ids: string[]
): Promise<BasicResponse> {
  return apiCall<BasicResponse>(session, 'reorderPhotos', {
    reportNo,
    slot,
    ids,
  });
}

export function apiGetPhoto(
  session: string,
  photoId: string,
  which: 'edited' | 'original'
): Promise<GetPhotoResponse> {
  return apiCall<GetPhotoResponse>(session, 'getPhoto', { photoId, which });
}

export function apiBuildReport(
  session: string,
  reportNo: string,
  format: 'docx' | 'pdf'
): Promise<BuildReportResponse> {
  return apiCall<BuildReportResponse>(session, 'build', { reportNo, format });
}
