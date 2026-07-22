"use client";

/**
 * iOS Safari kills the whole tab (blank page / silent reload) when a page's
 * memory footprint gets too high — there's no JS exception to catch, no
 * error boundary can save it. The only real mitigation is not letting a
 * ~2GB model load in the first place on a device likely to hit that wall.
 */
export function isLikelyMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const isTouchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1; // iPadOS reports as Mac
  return /iPhone|iPad|iPod|Android/.test(ua) || isTouchMac;
}
