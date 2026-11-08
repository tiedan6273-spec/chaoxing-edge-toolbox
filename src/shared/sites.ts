export type PlatformId = 'chaoxing' | 'zjooc';
export interface Platform {
  readonly id: PlatformId;
  readonly label: string;
  readonly matches: readonly string[];
}

/** Host policy shared by the manifest, feature registry, UI and background. */
export const PLATFORMS: readonly Platform[] = [
  { id: 'chaoxing', label: '学习通', matches: ['https://*.chaoxing.com/*', 'http://*.chaoxing.com/*'] },
  { id: 'zjooc', label: '浙学', matches: ['https://www.zjooc.cn/*'] },
];
export const SITE_MATCHES = PLATFORMS.flatMap(platform => platform.matches);
export const SUPPORTED_DOMAINS = ['chaoxing.com', 'www.zjooc.cn'] as const;

export function getPlatformById(id: PlatformId): Platform {
  return PLATFORMS.find(platform => platform.id === id)!;
}

export function getPlatform(value?: string): Platform | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol)
        && (url.hostname === 'chaoxing.com' || url.hostname.endsWith('.chaoxing.com'))) return getPlatformById('chaoxing');
    if (url.protocol === 'https:' && url.hostname === 'www.zjooc.cn') return getPlatformById('zjooc');
  } catch {
    // Invalid and browser-internal URLs have no supported platform.
  }
  return undefined;
}

export function isSupportedUrl(value?: string): boolean {
  return getPlatform(value) !== undefined;
}

export function isPlatformUrl(value: string | undefined, platform: PlatformId): boolean {
  return getPlatform(value)?.id === platform;
}

/** Blank frames inherit only an explicitly supported parent/referrer. */
export function getDocumentPlatform(win: Window): Platform | undefined {
  const platform = getPlatform(win.location.href);
  if (platform || !['about:blank', 'about:srcdoc'].includes(win.location.href)) return platform;
  try {
    const parent = getPlatform(win.parent.location.href);
    if (parent) return parent;
  } catch { /* Cross-origin blank frames can use their browser-provided referrer. */ }
  const referrer = getPlatform(win.document.referrer);
  return referrer;
}
