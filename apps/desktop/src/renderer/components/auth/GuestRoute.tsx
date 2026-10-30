import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';
import { LOCAL_ONLY_BUILD } from '@/lib/localOnlyBuild';

export function GuestRoute() {
  const location = useLocation();
  const returnTo = (location.state as { returnTo?: unknown } | null)?.returnTo;
  const destination = typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//') && !returnTo.startsWith('/login') ? returnTo : '/';
  const { mode, isInitializing, enterLocalMode } = useAuth();

  /**
   * Local-only build with no account: nothing would ever set the app mode, so
   * ProtectedRoute and this route bounce off each other forever (blank window
   * on a fresh install). Enter local mode once instead of showing a login
   * screen that does not exist.
   */
  useEffect(() => {
    if (!LOCAL_ONLY_BUILD || isInitializing) return;
    if (mode === 'signed-out') void enterLocalMode();
  }, [mode, isInitializing, enterLocalMode]);

  if (isInitializing) return null;
  // Local-only build: the login screen does not exist, even by deep link.
  if (LOCAL_ONLY_BUILD) {
    if (mode === 'signed-out') return null;
    return <Navigate to="/" replace />;
  }
  if (mode === 'cloud' || mode === 'local') return <Navigate to={destination} replace />;
  return <Outlet />;
}
