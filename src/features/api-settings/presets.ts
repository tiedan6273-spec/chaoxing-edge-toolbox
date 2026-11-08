import { emptyApiConfig, normalizeApiEndpoint, type ApiConfig } from './types';

export interface ApiPreset { id: string; name: string; endpoint: string; model: string; images: boolean; note: string; docs: string }
/** User-requested model IDs remain literal. Provider aliases are separate, explicit choices. */
export const API_PRESETS: readonly ApiPreset[] = [
  { id: 'deepseek-1017', name: 'DeepSeek V4.1 Flash 1017', endpoint: 'https://api.deepseek.com', model: 'deepseek-v4.1-flash-1017', images: true,
    note: '使用你指定的 1017 模型 ID；请确认所用接口支持此 ID。官方直连文档目前使用 deepseek-flash，可另选官方别名预设。', docs: 'https://api-docs.deepseek.com/zh-cn/updates/' },
  { id: 'deepseek-official', name: 'DeepSeek 1017 · 官方别名', endpoint: 'https://api.deepseek.com', model: 'deepseek-flash', images: true,
    note: '官方别名 deepseek-flash 当前对应 V4.1-Flash-1017；接口和 ID 均可手动编辑。', docs: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/' },
  { id: 'mimo-flash', name: 'MiMo V2.6 Flash · 按量付费', endpoint: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-flash', images: true,
    note: '按量付费 API Key 使用此入口；单价请按实际套餐填写。', docs: 'https://mimo.mi.com/docs/en-US/quick-start/summary/first-api-call' },
  { id: 'mimo-pro', name: 'MiMo V2.6 Pro · 按量付费', endpoint: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-pro', images: true,
    note: '按量付费 API Key 使用此入口；单价请按实际套餐填写。', docs: 'https://mimo.mi.com/docs/zh-CN/news/latest/v2-6' },
  { id: 'mimo-plan', name: 'MiMo V2.6 Flash · Token Plan', endpoint: 'https://token-plan-cn.xiaomimimo.com/v1', model: 'mimo-v2.6-flash', images: true,
    note: '使用 Token Plan 专属 Key；本机预算环不代表套餐 Credits 或剩余配额。', docs: 'https://mimo.mi.com/docs/en-US/quick-start/summary/first-api-call' },
];
export function presetApiConfig(id: string): ApiConfig {
  const preset = API_PRESETS.find(p => p.id === id);
  if (!preset) throw new Error('模型预设不存在。');
  return { ...emptyApiConfig(), endpoint: normalizeApiEndpoint(preset.endpoint), model: preset.model, supportsImages: preset.images };
}
