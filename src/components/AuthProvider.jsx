import React, { createContext, useState, useContext, useEffect } from 'react';
import { appParams } from '../lib/app-params';
import { getKvSync, removeKvSync, setKvSync } from '../lib/browserStorage';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [appPublicSettings, setAppPublicSettings] = useState(null); // Contains only { id, public_settings }

  useEffect(() => {
    checkAppState();
  }, []);

  const checkAppState = async () => {
    try {
      setIsLoadingPublicSettings(true);
      setAuthError(null);
      
      // Mock app public settings
      const publicSettings = {
        id: appParams.appId,
        public_settings: {
          name: 'MyBrain',
          description: 'A belief mapping application'
        }
      };
      setAppPublicSettings(publicSettings);
      
      // Check if user is authenticated (mock)
      if (appParams.token || getKvSync('your_brain_user')) {
        await checkUserAuth();
      } else {
        setIsLoadingAuth(false);
        setIsAuthenticated(false);
      }
      setIsLoadingPublicSettings(false);
    } catch (error) {
      console.error('Unexpected error:', error);
      setAuthError({
        type: 'unknown',
        message: error.message || 'An unexpected error occurred'
      });
      setIsLoadingPublicSettings(false);
      setIsLoadingAuth(false);
    }
  };

  const checkUserAuth = async () => {
    try {
      setIsLoadingAuth(true);
      // Mock user
      const currentUser = {
        id: 'user1',
        name: 'Demo User',
        email: 'demo@example.com'
      };
      setKvSync('your_brain_user', JSON.stringify(currentUser));
      setUser(currentUser);
      setIsAuthenticated(true);
      setIsLoadingAuth(false);
    } catch (error) {
      console.error('User auth check failed:', error);
      setIsLoadingAuth(false);
      setIsAuthenticated(false);
      setAuthError({
        type: 'auth_required',
        message: 'Authentication required'
      });
    }
  };

  const logout = (shouldRedirect = true) => {
    setUser(null);
    setIsAuthenticated(false);
    removeKvSync('your_brain_user');
    removeKvSync('your_brain_access_token');
    if (shouldRedirect) {
      // For now, just reload
      window.location.reload();
    }
  };

  const navigateToLogin = () => {
    // Mock login: set token
    const token = 'mock-token';
    setKvSync('your_brain_access_token', token);
    window.location.reload();
  };

  return (
    <AuthContext.Provider value={{ 
      user, 
      isAuthenticated, 
      isLoadingAuth,
      isLoadingPublicSettings,
      authError,
      appPublicSettings,
      logout,
      navigateToLogin,
      checkAppState
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
