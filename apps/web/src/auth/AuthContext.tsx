import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type {
  FieldPolicySummary,
  LoginRequest,
  MePermissionsResponse,
} from '@ticket/shared';
import {
  fetchMyPermissions,
  login as loginRequest,
  logout as logoutRequest,
  refreshSession,
  setAccessToken,
} from '../lib/api';

type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

interface AuthContextValue {
  status: AuthStatus;
  session: MePermissionsResponse | null;
  projectId: string | null;
  setProjectId: (projectId: string) => void;
  signIn: (payload: LoginRequest) => Promise<void>;
  signOut: () => Promise<void>;
  hasPermission: (resource: string, action: string) => boolean;
  fieldRule: (resource: string, field: string) => FieldPolicySummary | undefined;
  canWriteField: (resource: string, field: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<MePermissionsResponse | null>(null);
  const [projectId, setProjectIdState] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap(): Promise<void> {
      try {
        await refreshSession();
        const permissions = await fetchMyPermissions();
        if (cancelled) {
          return;
        }
        setSession(permissions);
        setProjectIdState(permissions.projects[0]?.id ?? null);
        setStatus('authenticated');
      } catch {
        if (!cancelled) {
          setAccessToken(null);
          setStatus('anonymous');
        }
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (payload: LoginRequest) => {
    await loginRequest(payload);
    const permissions = await fetchMyPermissions();
    setSession(permissions);
    setProjectIdState(permissions.projects[0]?.id ?? null);
    setStatus('authenticated');
  }, []);

  const signOut = useCallback(async () => {
    try {
      await logoutRequest();
    } finally {
      setSession(null);
      setProjectIdState(null);
      setAccessToken(null);
      setStatus('anonymous');
    }
  }, []);

  const hasPermission = useCallback(
    (resource: string, action: string) =>
      session?.permissions.some(
        (permission) => permission.resource === resource && permission.action === action,
      ) ?? false,
    [session],
  );

  const fieldRule = useCallback(
    (resource: string, field: string) =>
      session?.fields.find((item) => item.resource === resource && item.field === field),
    [session],
  );

  const canWriteField = useCallback(
    (resource: string, field: string) => fieldRule(resource, field)?.canWrite === true,
    [fieldRule],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      projectId,
      setProjectId: setProjectIdState,
      signIn,
      signOut,
      hasPermission,
      fieldRule,
      canWriteField,
    }),
    [status, session, projectId, signIn, signOut, hasPermission, fieldRule, canWriteField],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error('useAuth 必须在 AuthProvider 内使用');
  }
  return value;
}
