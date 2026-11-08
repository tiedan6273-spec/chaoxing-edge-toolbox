const paths = {
  logo: '<rect width="128" height="128" rx="28" fill="#0f766e"/><path d="M31 32h26c5 0 7 4 7 8 0-4 2-8 7-8h26v61H71c-4 0-7 3-7 6-1-3-4-6-7-6H31z" fill="#fff"/><path d="M64 40v52M40 48h13M40 60h13M76 48h12M76 60h12M76 72h12" fill="none" stroke="#0f766e" stroke-width="5" stroke-linecap="round"/>',
  paste: '<path d="M9 5V3h6v2M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="8" y="4" width="8" height="4" rx="1"/><path d="M8 13h8m-8 4h6"/>',
  extract: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8m-8 4h5"/>',
  ai: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM19 3v4m-2-2h4"/>',
  study: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="m10 8 5 3-5 3V8ZM8 21h8m-4-4v4"/>',
  settings: '<path d="M10.5 3L13.5 3L14 5.5L15.18 5.99L17.3 4.58L19.42 6.7L18.01 8.82L18.5 10L21 10.5L21 13.5L18.5 14L18.01 15.18L19.42 17.3L17.3 19.42L15.18 18.01L14 18.5L13.5 21L10.5 21L10 18.5L8.82 18.01L6.7 19.42L4.58 17.3L5.99 15.18L5.5 14L3 13.5L3 10.5L5.5 10L5.99 8.82L4.58 6.7L6.7 4.58L8.82 5.99L10 5.5Z"/><circle cx="12" cy="12" r="3"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  minimize: '<path d="M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="3.5"/>',
  play: '<path d="m8 4 12 8-12 8Z" fill="currentColor" stroke="none"/>',
  hide: '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
  reset: '<path d="M4 11a8 8 0 1 1 2 7M4 4v7h7"/>',
  grip: '<path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" stroke-width="3"/>',
} as const;

/** Only static local SVG markup enters the shadow tree through innerHTML. */
export function icon(name: keyof typeof paths, size = 18): string {
  if (name === 'logo') return `<svg viewBox="0 0 128 128" width="${size}" height="${size}" aria-hidden="true">${paths.logo.replaceAll('#0f766e', '#3e68e8')}</svg>`;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
