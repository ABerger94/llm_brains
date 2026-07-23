/**
 * iOS (all browsers, including Chrome) use WebKit; iPadOS 13+ may report as desktop Safari.
 */
export function isIOSDevice() {
  if (typeof navigator === 'undefined') return false;
  if (/iPad|iPhone|iPod/i.test(navigator.userAgent)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}
