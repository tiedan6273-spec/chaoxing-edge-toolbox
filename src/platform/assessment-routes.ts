import { getPlatform } from '../shared/sites';

export type AssessmentScene = 'exam' | 'homework';

/** The shell and question adapters must agree on assessment route prefixes. */
export function assessmentSceneFromUrl(value: string): AssessmentScene | undefined {
  try {
    const url = new URL(value);
    const platform = getPlatform(value)?.id;
    if (platform === 'chaoxing') {
      const match = /^\/(?:mooc-ans\/)?(?:mooc2\/)?(exam|work)(?:\/|$)/i.exec(url.pathname);
      return match?.[1].toLowerCase() === 'exam' ? 'exam' : match ? 'homework' : undefined;
    }
    if (platform !== 'zjooc') return undefined;
    const path = url.hash.startsWith('#/') ? url.hash.slice(1).split('?')[0] : url.pathname;
    if (!/^\/ucenter\/student\//i.test(path)) return undefined;
    if (/\/(?:exam|examination)(?:\/|$)/i.test(path)) return 'exam';
    if (/\/(?:homework|exercise|work)(?:\/|$)/i.test(path)) return 'homework';
  } catch { /* Malformed URLs never enable an assessment workspace. */ }
  return undefined;
}
