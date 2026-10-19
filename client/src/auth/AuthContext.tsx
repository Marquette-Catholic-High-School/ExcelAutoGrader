import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LoginRequest, RegisterRequest, User } from '@shared/types';
import { ApiRequestError, getToken, setToken, setUnauthorizedHandler } from '../api/client';
import { endpoints } from '../api/endpoints';
import { errorMessage } from '../utils/errors';

/** Waits between automatic re-checks of the stored session while the server can't be reached. */
const BOOT_RETRY_DELAYS_MS = [1000, 2000, 4000];
const BOOT_RETRY_EVERY_MS = 5000;

interface AuthState {
  user: User | null;
  /** True until the stored token has been checked on startup (it stays true while bootError is set). */
  loading: boolean;
  /**
   * Set while the startup session check fails for any reason other than a 401 (server down or restarting,
   * 5xx, network error). The token is kept and the check is retried automatically; the route guards show a
   * "Can't reach the server" card instead of redirecting to /login.
   */
  bootError: string | null;
  /** True while a startup session check is in flight (for the Retry button). */
  retrying: boolean;
  /** Re-run the startup session check now. */
  retry: () => void;
  /**
   * True after the user signed out on purpose, until the next sign-in. The route guard then sends them to /login
   * without remembering the page they left (which the next person to sign in would otherwise land on).
   */
  signedOut: boolean;
  login: (body: LoginRequest) => Promise<User>;
  /** `claimedClasses`: classes a teacher had already added this email to (empty for an ordinary sign-up). */
  register: (body: RegisterRequest) => Promise<{ user: User; claimedClasses: string[] }>;
  logout: () => Promise<void>;
  /** Replace the cached user (e.g. after changing password). */
  setUser: (user: User) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUserState] = useState<User | null>(null);
  const [loading, setLoading] = useState(() => !!getToken());
  const [bootError, setBootError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const checkNow = useRef<() => void>(() => {});

  const clear = useCallback(() => {
    setToken(null);
    setUserState(null);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    setUnauthorizedHandler(clear);
    return () => setUnauthorizedHandler(null);
  }, [clear]);

  // Startup: check the stored token. Only a 401 means the session is gone; any other failure (e.g. `npm run dev`
  // reloading the tab before the API listens, so the proxy answers 500) keeps the token and retries with backoff.
  useEffect(() => {
    if (!getToken()) return;
    let cancelled = false;
    let inFlight = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const check = () => {
      if (cancelled || inFlight) return;
      clearTimeout(timer);
      inFlight = true;
      setRetrying(true);
      endpoints
        .me()
        .then(
          ({ user }) => {
            if (cancelled) return;
            setBootError(null);
            setUserState(user);
            setLoading(false);
          },
          (err: unknown) => {
            if (cancelled) return;
            if (err instanceof ApiRequestError && err.status === 401) {
              // Unknown, signed-out or expired token (the 401 handler has already cleared it too).
              clear();
              setBootError(null);
              setLoading(false);
              return;
            }
            setBootError(errorMessage(err));
            timer = setTimeout(check, BOOT_RETRY_DELAYS_MS[failures] ?? BOOT_RETRY_EVERY_MS);
            failures += 1;
          },
        )
        .finally(() => {
          inFlight = false;
          if (!cancelled) setRetrying(false);
        });
    };

    checkNow.current = check;
    check();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      checkNow.current = () => {};
    };
  }, [clear]);

  const retry = useCallback(() => checkNow.current(), []);

  const login = useCallback(async (body: LoginRequest) => {
    const res = await endpoints.login(body);
    queryClient.clear();
    setToken(res.token);
    setSignedOut(false);
    setUserState(res.user);
    return res.user;
  }, [queryClient]);

  const register = useCallback(async (body: RegisterRequest) => {
    const res = await endpoints.register(body);
    queryClient.clear();
    setToken(res.token);
    setSignedOut(false);
    setUserState(res.user);
    return { user: res.user, claimedClasses: res.claimedClasses ?? [] };
  }, [queryClient]);

  const logout = useCallback(async () => {
    try {
      await endpoints.logout();
    } catch {
      // already invalid — clear locally anyway
    }
    setSignedOut(true);
    clear();
  }, [clear]);

  const setUser = useCallback((next: User) => {
    setSignedOut(false);
    setUserState(next);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, loading, bootError, retrying, retry, signedOut, login, register, logout, setUser }),
    [user, loading, bootError, retrying, retry, signedOut, login, register, logout, setUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** For pages behind a role guard: the signed-in user (never null there). */
export function useUser(): User {
  const { user } = useAuth();
  if (!user) throw new Error('useUser called without a signed-in user');
  return user;
}
