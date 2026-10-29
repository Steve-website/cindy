import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';
import { LOCAL_ONLY_BUILD } from '@/lib/localOnlyBuild';

export function GuestRoute() {
  const location = useLocation();
  const returnTo = (location.state as { returnTo?: unknown } | null)?.returnTo;
  const destination = typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//') && !returnTo.startsWith('/login') ? returnTo : '/';
  const { mode, isInitializing } = useAuth();

  if (isInitializing) return null;
  // Local-only build: the login screen does not exist, even by deep link.
  if (LOCAL_ONLY_BUILD) return <Navigate to="/" replace />;
  if (mode === 'cloud' || mode === 'local') return <Navigate to={destination} replace />;
  return <Outlet />;
}
