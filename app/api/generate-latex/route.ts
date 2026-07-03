// POST /api/generate-latex
// 输入：{ paperContent: string }
// 输出：ZIP 文件（含 summary.tex + references.bib）
// 用途：将论文内容转为 LaTeX 结构化总结，可在 Overleaf 中用 XeLaTeX 编译

import { NextRequest } from "next/server";
import { after } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { checkUsageLimit, insertUsageRecord } from "@/lib/supabase";
import JSZip from "jszip";

export async function POST(req: NextRequest) {
  try {
    const apiKey = (process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_API_KEY);
    if (!apiKey) {
      return Response.json({ error: "服务器未配置 API Key，请检查 .env.local 文件" }, { status: 500 });
    }

    const { allowed, used, limit, userId } = await checkUsageLimit("latex_export");
    if (!allowed) {
      return Response.json(
        { error: `本月导出 LaTeX 次数已用完（${used}/${limit} 次），下月 1 日自动重置` },
        { status: 429 }
      );
    }

    const { paperContent } = await req.json() as { paperContent: string };
    if (!paperContent || paperContent.trim().length === 0) {
      return Response.json({ error: "论文内容为空" }, { status: 400 });
    }

    const truncatedContent = paperContent.slice(0, 80000);

    const anthropicRes = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        max_tokens: 16000,
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content: `请根据以下学术论文内容，生成两个文件的内容：一个 LaTeX .tex 文件和一个 BibTeX .bib 文件。

【严格输出格式】
只输出以下格式，不得有任何其他文字：

===TEX_START===
（完整的 .tex 文件内容）
===TEX_END===
===BIB_START===
（完整的 .bib 文件内容）
===BIB_END===

【.tex 文件要求】
- 第一行固定是：% 请在 Overleaf 中选择 XeLaTeX 编译器
- 使用 \\documentclass{article}
- 加载宏包：\\usepackage{ctex}、\\usepackage[hidelinks]{hyperref}、\\usepackage{geometry}，其中 geometry 用 \\geometry{a4paper, margin=2.5cm}
- \\title{}、\\author{}、\\date{} 从论文提取真实内容；提取不到的字段写 TODO
- \\begin{document} 之后先 \\maketitle
- 正文写四个章节（用 \\section），标题固定为：研究背景与动机、研究方法、主要结果、结论与展望
- 每节写 3-5 段中文内容，语言正式，保留关键数据和实验发现
- 在正文中用 \\cite{key} 引用原论文（key 与 .bib 文件中一致）
- 文档末尾：\\bibliography{references} 和 \\bibliographystyle{plain}，然后 \\end{document}

【.bib 文件要求】
- 根据论文性质选类型：@article（期刊）/ @inproceedings（会议）/ @misc（其他）
- 尽量从论文中提取：author、title、journal/booktitle、year、volume、pages、doi
- 提取不到的字段写 TODO，例如：volume = {TODO}
- BibTeX key 格式：第一作者姓+年份，如 zhang2023

论文内容如下：
---
${truncatedContent}
---`,
          },
        ],
      }),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      console.error(`[generate-latex] Anthropic API 错误 ${anthropicRes.status}:`, errBody);
      return Response.json({ error: `AI 服务错误（${anthropicRes.status}），请稍后重试` }, { status: 500 });
    }

    const data = await anthropicRes.json();
    const textBlock = data.content?.find((b: { type: string }) => b.type === "text");
    const raw: string = textBlock?.text ?? "";

    // 记录用量（后台异步，不阻塞响应）
    if (userId) {
      after(async () => {
        await insertUsageRecord({
          userId,
          actionType: "latex_export",
          tokensInput:          data.usage?.input_tokens ?? 0,
          tokensOutput:         data.usage?.output_tokens ?? 0,
          cacheCreationTokens:  data.usage?.cache_creation_input_tokens ?? 0,
          cacheReadTokens:      data.usage?.cache_read_input_tokens ?? 0,
        });
      });
    }

    // 解析 tex 和 bib 内容（用分隔符，避免 JSON 转义 LaTeX 反斜杠的问题）
    const texMatch = raw.match(/===TEX_START===\n([\s\S]*?)===TEX_END===/);
    const bibMatch = raw.match(/===BIB_START===\n([\s\S]*?)===BIB_END===/);

    if (!texMatch || !bibMatch) {
      console.error("[generate-latex] 解析失败，原始输出前500字：", raw.slice(0, 500));
      return Response.json({ error: "AI 生成格式异常，请重试" }, { status: 500 });
    }

    const texContent = texMatch[1].trim();
    const bibContent = bibMatch[1].trim();

    // 打包成 ZIP
    const zip = new JSZip();
    zip.file("summary.tex", texContent);
    zip.file("references.bib", bibContent);
    const buffer = await zip.generateAsync({ type: "arraybuffer" });

    return new Response(buffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="latex_export.zip"',
      },
    });
  } catch (error) {
    console.error("[generate-latex] 请求失败:", error);
    const msg = error instanceof Error ? error.message : "导出失败，请重试";
    return Response.json({ error: msg }, { status: 500 });
  }
}
