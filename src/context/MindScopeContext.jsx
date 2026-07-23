import { createContext, useContext, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { pathnameHasMindMirror } from '../lib/mindScopePaths';
import { primaryEntities, mirrorEntities } from '../lib/mindScopeEntities';

const MindScopeContext = createContext({
  isMirror: false,
  profile: 'primary',
  entities: primaryEntities,
});

export function MindScopeProvider({ children }) {
  const { pathname } = useLocation();
  const isMirror = pathnameHasMindMirror(pathname);
  const value = useMemo(
    () => ({
      isMirror,
      profile: isMirror ? 'playgroundMirror' : 'primary',
      entities: isMirror ? mirrorEntities : primaryEntities,
    }),
    [isMirror]
  );
  return <MindScopeContext.Provider value={value}>{children}</MindScopeContext.Provider>;
}

export function useMindScope() {
  return useContext(MindScopeContext);
}

/**
 * Entity managers for the current route (primary vs mirror).
 * @returns {typeof import('../lib/mindScopeEntities').primaryEntities}
 */
export function useScopedEntities() {
  const { entities } = useMindScope();
  return entities;
}
