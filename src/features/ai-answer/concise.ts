/** Instruct the same generation to produce the final concise text; no second paid summary call. */
export const CONCISE_TEXT_INSTRUCTION = [
  '文本填写题先在内部归纳，再只输出精简后的最终答案：直接给结论与必要得分点，通常用 1 段或 2—4 个短要点，去掉重复、铺垫、题干复述和额外总结。',
  '保留必要的专有名词、否定条件、数值、单位、公式和完整结论；题干明确要求的字数、论述深度、证明步骤、要点数量或原文引用优先于精简要求。',
  '填空题只给每一空所需的词句，不增加解释；简答题逐项回答所问内容；论述/计算题保留必要论证或计算步骤；代码与指定原文不得删改或截断。',
].join('\n');
