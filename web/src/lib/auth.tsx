import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import type { AppInfo, User, WorkspaceSummary } from './types';

interface Session {
  user: User | null;
  workspaces: WorkspaceSummary[];
  app: AppInfo | null;
}

interface AuthContextValue extends Session {
  loading: boolean;
  refresh: () => Promise<Session>;
  setSession: (s: Partial<Session>) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<Session>({ user: null, workspaces: [], app: null });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const data = await api<Session>('/api/auth/me');
    setSessionState(data);
    return data;
  }, []);

  useEffect(() => {
    refresh()
      .catch(() => setSessionState({ user: null, workspaces: [], app: null }))
      .finally(() => setLoading(false));
  }, [refresh]);

  const setSession = useCallback((s: Partial<Session>) => setSessionState((prev) => ({ ...prev, ...s })), []);

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    setSessionState((prev) => ({ ...prev, user: null, workspaces: [] }));
  }, []);

  const value = useMemo(() => ({ ...session, loading, refresh, setSession, logout }), [session, loading, refresh, setSession, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
