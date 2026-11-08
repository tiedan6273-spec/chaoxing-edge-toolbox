import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const files = {};
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = resolve(directory, entry.name);
    if (entry.isDirectory()) await collect(filename);
    else files[relative(resolve(root, 'dist'), filename).replaceAll('\\', '/')] = new Uint8Array(await readFile(filename));
  }
}
await collect(resolve(root, 'dist'));
files['安装说明.txt'] = new TextEncoder().encode([
  `学习工具箱 ${version}（候选版）`, '',
  '1. 将此压缩包解压到固定文件夹。',
  '2. Edge 地址栏输入 edge://extensions，开启开发人员模式。',
  '3. 点击“加载解压缩的扩展”，选择含 manifest.json 的解压文件夹。',
  '4. 更新已有扩展时点击“重新加载”，再刷新已打开的学习通或浙学网页。',
  '5. 点击浏览器扩展图标打开工具箱；标题栏减号最小化，更多菜单中可隐藏为悬浮入口。',
  '6. 进入题目页先识别当前页，配置并选择答案来源后处理。已有答案默认保留，保存与交卷由用户核对。', '',
  '7. 浙学视频页可在自动学习开关下选择播放倍速；默认平台最高，选项取自当前播放器，保存后在当前及后续视频应用。', '',
  '8. 浙学“学习起点”选择“从当前内容往后”，再点“从当前内容开始”，即可跳过之前的内容。普通继续和同一标签页刷新沿用本次起点及进度；手动换页后可再次点击该按钮重设起点。', '',
  '9. 题目结果区选择 TXT 或 JSON 后点击“导出题目与答案”；导出当前已加载内容和现有结果，不额外调用 AI。TXT 直接阅读，JSON 为独立的结构数据格式。', '',
  '10. 设置页“题库管理 → 我的题库”可导入 TXT/JSON/DOCX/PDF/图片。结构提取支持表格、基本编号、上下标和 PDF 分栏；扫描/混合 PDF 选本地 OCR，图片自动识别。识别文本须整理成固定模板、重新校验并对照来源确认后入库；旧 DOC 先另存为 DOCX。', '',
  '11. 当前课程“答题设置 → 本地题库辅助”启用并选择适用题库，保存后先识别再处理。仅本地模式无需 API；未匹配时是否联网补充由开关和在线来源共同决定。', '',
  '12. 结果区选择“题库模板 TXT”并明确答案来源，可导出可重新导入的模板。完整匹配不代表答案已被平台验证，填写后请核对。', '',
  '13. 题目页先识别，再选择“只搜题 / 自动填写”和“仅本题 / 当前题及后续 / 当前已加载全部题”。回看页只能搜题；应用参考答案需再次核对，有内容时须确认覆盖。暂停复用本页完整结果，刷新不自动恢复。', '',
  '14. 没有课程编号的浙学页面会按页面单独选库，更新后请重新勾选适用库；题库内容保留。当前已加载题目流程保持原入口；跨页需单独启动实验功能，平台保存状态请自行核对，最终交卷由用户操作。', '',
  '15. 刷新后识别题目，在“本机搜题记录”显式恢复匹配参考结果，再确认范围继续；恢复不会填写。记录默认保留 7 天，设置中可关闭或清空。', '',
  '16. “AI 与用量”设置中可填写当前接口/模型单价与本轮预算。达到预算或费用未知后阻止下一次 AI 请求；单次请求可能超出阈值，最终以账单为准。浙学同一步骤连续失败会暂停，检查原网页后继续。', '',
  '17. API 模型列表支持 10 个模型、启停和数字优先级（越小越先）。可快速新建 DeepSeek 1017 / MiMo V2.6 模型，填写各自 Key 并保存。DeepSeek 默认 ID 为用户指定的 deepseek-v4.1-flash-1017，所用接口须支持此 ID；官方别名 deepseek-flash 为另一个可选预设。模型 ID 会原样发送。', '',
  '18. 用量环显示本轮已知预计费用占本机预算的比例，未知费用、超限和未设预算分别展示；不是服务商账户余额或 Token Plan 配额。各模型单价分别设置，统计与预算全模型共享。', '',
  '19. AI 整卷复检区分本地读取、一次模型请求和返回核验；同卷同答案可复用结果，确认“重新请求 AI”才强制重发。红色 ≠ 标记当前答案与 AI 结果不一致，详情显示两份答案；人工改答案后点击刷新阅览更新比较。文本题同次请求归纳为精简最终答案，题目明确的字数/步骤要求优先。', '',
  '20. 题库详情支持单题编辑、版本冲突检查、修改记录与撤销；题目详情可收藏或手动标记错题。在“题库管理”管理标签、笔记与掌握状态，可导出 TXT 或完整备份。完整恢复将替换题库与收藏，先预览确认。', '',
  '21. 思维阶梯支持与普通题目共用本地优先来源、只搜题和显式填写；相似题参考展示条件差异，需人工核对，不自动应用。', '',
  '22. “当前页及后续页”为实验功能：只在稳定试卷标识、页码、唯一原生下一页入口均识别成功后运行。填写模式必须完整回读并收到新的草稿保存反馈；保存不明、换卷或重复页会停留。会话进度可显式恢复，迷你条可暂停，不自动交卷。真实双平台仍需验证。', '',
  '23. OCR 引擎与中英文语言包已离线内置，无需 API。支持 PDF 页码范围、阅读顺序和百分比区域截取，OCR 每批最多 20 页/图片。修改设置后点“重新读取”；识别可能出错，复杂公式/对象占位须手动转写，勾选来源校对后才能入库。取消或关闭设置页会停止 Worker。', '',
  '24. AI 与用量页面改为用量卡片和模型列表，可直接启停、上移/下移、配置、测试与移除；移除可撤销，列表改动保存后生效。编辑窗取消会回滚当前编辑，快速预设 Key 独立填写。卡片显示所有模型合计的本机预计费用与 Token，不代表服务商余额。价格/预算、搜题记录与配置备份默认折叠。', '',
  '浙学考试适配待真实页面验证；如未识别题目，请保留页面结构和复现步骤以便补充适配。',
  '已通过本地构造样本与浏览器 UI 检查的部分，不代表真实考试均兼容。',
  '详细说明和当前支持范围见 README.md。', '',
].join('\r\n'));
files['README.md'] = new Uint8Array(await readFile(resolve(root, 'README.md')));
await mkdir(resolve(root, 'release'), { recursive: true });
const destination = resolve(root, `release/chaoxing-edge-toolbox-${version}.zip`);
await writeFile(destination, zipSync(files, { level: 9 }));
console.log(`安装压缩包：${destination}`);
