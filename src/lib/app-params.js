import { getKvSync, removeKvSync, setKvSync } from './browserStorage';

const isNode = typeof window === 'undefined';

const toSnakeCase = (str) => {
  return str.replace(/([A-Z])/g, '_$1').toLowerCase();
};

function storageGetItem(key) {
  if (isNode) return null;
  return getKvSync(key);
}

function storageSetItem(key, v) {
  if (isNode) return;
  setKvSync(key, v);
}

function storageRemoveItem(key) {
  if (isNode) return;
  removeKvSync(key);
}

const getAppParamValue = (paramName, { defaultValue = undefined, removeFromUrl = false } = {}) => {
  if (isNode) {
    return defaultValue;
  }
  const storageKey = `my_brain_${toSnakeCase(paramName)}`;
  const legacyStorageKey = `your_brain_${toSnakeCase(paramName)}`;
  const urlParams = new URLSearchParams(window.location.search);
  const searchParam = urlParams.get(paramName);
  if (removeFromUrl) {
    urlParams.delete(paramName);
    const newUrl = `${window.location.pathname}${urlParams.toString() ? `?${urlParams.toString()}` : ''}${window.location.hash}`;
    window.history.replaceState({}, document.title, newUrl);
  }
  if (searchParam) {
    storageSetItem(storageKey, searchParam);
    return searchParam;
  }
  if (defaultValue) {
    storageSetItem(storageKey, defaultValue);
    return defaultValue;
  }
  const storedValue = storageGetItem(storageKey) || storageGetItem(legacyStorageKey);
  if (storedValue) {
    if (!storageGetItem(storageKey) && storageGetItem(legacyStorageKey)) {
      storageSetItem(storageKey, storedValue);
    }
    return storedValue;
  }
  return null;
};

const getAppParams = () => {
  if (getAppParamValue('clear_access_token') === 'true') {
    storageRemoveItem('my_brain_access_token');
    storageRemoveItem('your_brain_access_token');
    storageRemoveItem('token');
  }
  return {
    appId: getAppParamValue('app_id', { defaultValue: import.meta.env.VITE_APP_ID || 'my-brain-app' }),
    token: getAppParamValue('access_token', { removeFromUrl: true }),
    fromUrl: getAppParamValue('from_url', { defaultValue: window.location.href }),
    functionsVersion: getAppParamValue('functions_version', { defaultValue: '1.0' }),
    appBaseUrl: getAppParamValue('app_base_url', { defaultValue: window.location.origin }),
  };
};

export const appParams = {
  ...getAppParams(),
};
