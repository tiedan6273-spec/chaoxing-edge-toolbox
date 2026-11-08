import { requestChatCompletion as request, ModelRequestError, type ChatCompletionOptions } from './model-client';
import type { TokenUsage } from '../activity/types';
export type { ChatContentPart, ChatMessage } from './model-client';

/** Every extension-owned model request, including tests and reviews, shares one durable budget. */
export const requestChatCompletion: typeof request = async (config, messages, signal, progress, options: ChatCompletionOptions = {}) => {
  if (signal.aborted) throw new ModelRequestError('cancelled', '已取消生成。');
  const { beginUsage, finishUsage, UsageBudgetError } = await import('../activity/usage-background');
  const ticket = await beginUsage(config).catch(error => {
    throw new ModelRequestError('budget', error instanceof UsageBudgetError ? error.message : '无法可靠记录 AI 用量，已停止请求；请检查扩展存储后重试。');
  });
  let usage: TokenUsage | undefined;
  try {
    return await request(config, messages, signal, progress, { ...options, onUsage: value => { usage = value; options.onUsage?.(value); } });
  } finally {
    await finishUsage(ticket, usage).catch(() => { throw new ModelRequestError('usage-storage', 'AI 请求已结束，但用量保存失败。请核对账单并检查扩展存储，避免重复请求。'); });
  }
};
