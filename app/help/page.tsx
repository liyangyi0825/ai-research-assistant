"use client";

import { useState, useMemo } from "react";

interface Feature {
  icon: string;
  title: string;
  what: string;
  when: string;
  steps: string[];
  tip: string;
}

const FEATURES: Feature[] = [
  {
    icon: "📄",
    title: "上传论文 · AI 总结",
    what: "上传 PDF 格式的学术论文，AI 自动读取全文并生成结构化摘要，包括研究背景、研究方法、关键发现和结论四个维度。",
    when: "拿到一篇新论文，想在 5 分钟内弄清楚它讲什么、值不值得精读时。",
    steps: [
      "点击左侧「上传论文」或首页上传区域，选择 PDF 文件（最大 50 MB）",
      "文件上传后系统会自动提取文字，稍等片刻",
      "点击「AI 生成总结」按钮，等待约 15–30 秒",
      "查看生成的结构化摘要，可复制或继续对话",
    ],
    tip: "中英文论文均支持；总结会保留在「研究笔记」里，随时可回看。",
  },
  {
    icon: "💬",
    title: "与论文对话",
    what: "在同一页面基于论文内容进行多轮问答。AI 只根据你上传的这篇论文回答，不会「编造」原文没有的内容。",
    when: "读总结之后还有疑问，比如想追问某个实验细节、某段数据的含义，或让 AI 用更简单的话解释某个概念时。",
    steps: [
      "在上传并总结论文之后，页面下方会出现对话框",
      "在输入框里输入你的问题，例如「第三章用的什么统计方法？」",
      "按回车或点击发送，AI 会引用论文原文回答",
      "可以连续追问，AI 会记住上下文",
    ],
    tip: "问题越具体，答案越准确。如果问题超出论文范围，AI 会主动告知。",
  },
  {
    icon: "🌐",
    title: "全文对照翻译",
    what: "上传英文 PDF，左边显示原文、右边显示中文译文，两侧同步滚动，中英对照阅读。",
    when: "需要阅读英文论文，想要中英对照理解每一段内容时。",
    steps: [
      "点击左侧「全文翻译」入口",
      "直接上传英文 PDF（不需要先生成总结）",
      "等待翻译完成（通常 30–60 秒）",
      "左右对照阅读，两边同步滚动",
    ],
    tip: "支持文字版 PDF，不支持扫描版（扫描版无法提取文字）。推荐从 arXiv、Google Scholar、期刊官网下载的 PDF 文件。专业术语保留英文并用括号标注。",
  },
  {
    icon: "🔍",
    title: "生成检索词",
    what: "根据你的研究方向，AI 生成一套可直接用于 Web of Science、Scopus、CNKI 等数据库的检索式，包含主题词、同义词和布尔逻辑组合。",
    when: "开展文献综述、想系统地搜集某一领域的文章时，或者自己搜索总是找不到想要的论文时。",
    steps: [
      "点击左侧「生成检索词」进入功能页",
      "在输入框描述你的研究课题，尽量具体（例如「锂电池硅负极循环稳定性」）",
      "点击「生成检索词」，AI 会输出多组检索策略",
      "复制检索式，粘贴到目标数据库的高级搜索框即可",
    ],
    tip: "描述越详细，生成的检索词越精准；可以尝试用不同的描述角度多生成几组。",
  },
  {
    icon: "🧭",
    title: "概念探索器",
    what: "输入任意学术概念或术语，AI 给出通俗解释、学科背景，以及与之相关的上位概念、下位概念和同级概念，帮你建立知识网络。",
    when: "读论文时遇到不认识的名词；或者刚进入一个新的研究方向，想快速了解这个领域的基本概念体系时。",
    steps: [
      "点击左侧「概念探索器」进入功能页",
      "在输入框输入你想了解的概念（中英文均可）",
      "点击「探索」，AI 会生成解释和概念地图",
      "点击相关概念可以继续深入探索",
    ],
    tip: "适合「扫盲」用，遇到不懂的词直接搜。也可以把概念复制到对话框里，结合论文内容进一步追问。",
  },
  {
    icon: "📚",
    title: "多篇综述对比",
    what: "上传 2-10 篇相关论文，AI 自动提取每篇核心内容，帮你找出研究异同、脉络和空白，快速建立领域全局认知。",
    when: "做文献综述时需要横向对比多篇论文的研究方法、结论和创新点；或者刚进入一个新领域，想快速梳理现有研究的整体格局时。",
    steps: [
      "点击左侧「多篇综述对比」进入功能页",
      "同时选择 2-10 篇 PDF 论文上传（建议上传同一研究领域的论文）",
      "点击开始分析，AI 会提取每篇论文前 8000 字进行对比分析",
      "查看生成的对比结果，找出研究异同、脉络与空白",
    ],
    tip: "每次上传 2-5 篇可获得最精准的分析结果；建议上传同一研究领域的论文，横向对比效果最佳。",
  },
  {
    icon: "🎯",
    title: "论文转 PPT",
    what: "上传论文 PDF，AI 自动生成答辩或汇报用的 PPT 文件，可直接下载 .pptx 格式。",
    when: "毕业答辩准备、研究生组会汇报，需要快速生成演示文稿时。",
    steps: [
      "点击左侧「论文转 PPT」入口",
      "直接上传 PDF（不需要先生成总结）",
      "选择用途：毕业答辩 或 组会汇报",
      "等待生成，在网页预览后下载 .pptx 文件",
    ],
    tip: "生成内容框架，建议下载后自行美化配色。",
  },
  {
    icon: "📊",
    title: "数据清洗",
    what: "上传杂乱的 Excel 或 CSV 文件，AI 自动识别数据问题（缺失值、格式不统一、异常值等），生成清洗方案，一键整理成规范表格并生成可视化图表。",
    when: "需要处理实验数据、调查问卷数据时；数据表格里有大量空行、单位不统一、数字格式混乱等问题时。",
    steps: [
      "点击左侧「数据清洗」入口",
      "上传 Excel（.xlsx / .xls）或 CSV 文件",
      "点击「开始 AI 分析」，AI 自动识别数据问题并生成清洗方案",
      "逐条确认清洗规则（可按需勾选或取消），点击「执行清洗」",
      "预览清洗前后对比和 AI 推荐图表，下载整理好的 Excel 文件",
    ],
    tip: "支持 .xlsx、.xls、.csv 格式，文件不超过 10MB、不超过 10 万行。清洗在浏览器本地执行，数据不会上传到服务器。",
  },
  {
    icon: "👤",
    title: "我的科研档案",
    what: "记录你的研究方向、学科背景、已掌握的技能和正在进行的课题，形成个人学术画像。",
    when: "首次使用时建议填写，完善后 AI 的回答会更贴合你的研究背景和知识水平。",
    steps: [
      "点击左侧「我的科研档案」",
      "填写研究方向（如「材料科学 / 锂电池」）、学历阶段、主要技能",
      "可以添加正在进行的课题描述",
      "点击保存，之后每次使用 AI 功能时都会参考这些信息",
    ],
    tip: "档案不需要填得很完整也能正常使用；但越完整，AI 的个性化程度越高。",
  },
  {
    icon: "📝",
    title: "我的研究笔记",
    what: "汇总你历史上所有的论文分析记录、搜索历史和笔记，按时间排列，方便随时回溯。",
    when: "想找回之前读过的某篇论文的总结、或者查看某次检索词生成的结果时。",
    steps: [
      "点击左侧「我的研究笔记」",
      "在列表中按时间或标题浏览历史记录",
      "点击某条记录可以展开查看详情",
      "可以在详情页继续对话或重新生成内容",
    ],
    tip: "所有分析结果会自动保存，不需要手动记录；清除浏览器缓存不会影响这里的数据。",
  },
  {
    icon: "💬",
    title: "意见反馈",
    what: "告诉我们你遇到的 Bug、体验问题或功能建议，帮助我们持续改进产品。",
    when: "发现页面报错、功能异常、AI 回答质量问题，或者有好的功能想法时，随时可以反馈。",
    steps: [
      "点击侧边栏「意见反馈」，或页面右下角的悬浮「反馈」按钮",
      "在弹窗里描述问题或建议（至少 10 个字）",
      "可以选择上传截图，帮我们更快定位问题",
      "留下邮箱（可选），方便我们回复进展",
    ],
    tip: "每一条反馈我们都会认真阅读；如果是功能建议，我们会在路线图里认真考虑。",
  },
];

export default function HelpPage() {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return FEATURES;
    return FEATURES.filter(
      (f) =>
        f.title.toLowerCase().includes(q) ||
        f.what.toLowerCase().includes(q) ||
        f.when.toLowerCase().includes(q) ||
        f.steps.some((s) => s.toLowerCase().includes(q))
    );
  }, [query]);

  return (
    <div className="min-h-full px-4 py-10 max-w-5xl mx-auto">
      {/* 页头 */}
      <div className="mb-8 text-center">
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-2">帮助中心</h1>
        <p className="text-gray-500 text-sm sm:text-base">了解易研的所有功能，快速上手</p>
      </div>

      {/* 搜索栏 */}
      <div className="relative max-w-md mx-auto mb-10">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-lg pointer-events-none">
          🔍
        </span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索功能名称或关键词…"
          className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-200 bg-white text-sm outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400 transition-all"
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-lg leading-none"
          >
            ×
          </button>
        )}
      </div>

      {/* 无结果提示 */}
      {filtered.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3">🔎</div>
          <p className="text-base">没有找到「{query}」相关的功能</p>
          <button
            onClick={() => setQuery("")}
            className="mt-3 text-sm text-blue-500 hover:underline"
          >
            清空搜索
          </button>
        </div>
      )}

      {/* 功能卡片网格 */}
      <div className="grid gap-5 sm:grid-cols-2">
        {filtered.map((feature) => (
          <div
            key={feature.title}
            className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 flex flex-col gap-4 hover:shadow-md transition-shadow"
          >
            {/* 卡片标题 */}
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0"
                style={{ background: "#EFF6FF" }}
              >
                {feature.icon}
              </div>
              <h2 className="text-base font-semibold text-gray-800">{feature.title}</h2>
            </div>

            {/* 是什么 */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-blue-500 mb-1">是什么</p>
              <p className="text-sm text-gray-600 leading-relaxed">{feature.what}</p>
            </div>

            {/* 适合场景 */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-purple-500 mb-1">适合场景</p>
              <p className="text-sm text-gray-600 leading-relaxed">{feature.when}</p>
            </div>

            {/* 使用步骤 */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-green-600 mb-2">怎么使用</p>
              <ol className="space-y-1.5">
                {feature.steps.map((step, i) => (
                  <li key={i} className="flex gap-2.5 text-sm text-gray-600">
                    <span
                      className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold text-white mt-0.5"
                      style={{ background: "#3B82F6" }}
                    >
                      {i + 1}
                    </span>
                    <span className="leading-relaxed">{step}</span>
                  </li>
                ))}
              </ol>
            </div>

            {/* 提示 */}
            <div className="rounded-xl px-4 py-3 text-sm text-amber-800 leading-relaxed" style={{ background: "#FFFBEB", border: "1px solid #FDE68A" }}>
              <span className="font-medium">💡 提示：</span>{feature.tip}
            </div>
          </div>
        ))}
      </div>

      {/* 底部联系 */}
      <div className="mt-12 text-center text-sm text-gray-400">
        没有找到答案？
        <button
          onClick={() => window.dispatchEvent(new Event("open-feedback"))}
          className="ml-1 text-blue-500 hover:underline"
        >
          点击反馈给我们
        </button>
      </div>
    </div>
  );
}
