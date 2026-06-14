// POST /api/papers/search
// 输入：{ keywords: string（英文检索词）, topic: string（用户课题） }
// 输出：{ papers: AnalyzedPaper[] }
// 流程：Semantic Scholar 搜索 → Claude 一次性批量分析相关性 + 翻译标题

import { NextRequest, NextResponse } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { checkUsageLimit, insertUsageRecord } from "@/lib/supabase";

interface SemPaper {
  paperId: string;
  title: string;
  authors: { name: string }[];
  year: number | null;
  abstract: string | null;
  citationCount: number | null;
  externalIds: { DOI?: string; ArXiv?: string } | null;
}

export interface AnalyzedPaper {
  paperId: string;
  title: string;
  titleCn: string;
  authors: string[];
  year: number | null;
  citationCount: number | null;
  abstract: string;
  relevanceNote: string;
  stars: number;
  doi: string | null;
  arxivId: string | null;
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "服务器未配置 API Key" }, { status: 500 });

    // 复用 keyword_gen 配额（AI 精准搜索消耗一次）
    const { allowed, used, limit, userId } = await checkUsageLimit("keyword_gen");
    if (!allowed) {
      return NextResponse.json(
        { error: `本月关键词/搜索次数已用完（${used}/${limit} 次），下月 1 日自动重置` },
        { status: 429 },
      );
    }

    const { keywords, topic } = (await req.json()) as { keywords: string; topic: string };
    if (!keywords?.trim()) return NextResponse.json({ error: "关键词不能为空" }, { status: 400 });

    // ── 1. Semantic Scholar 搜索 ──────────────────────────────────────────
    let rawPapers: SemPaper[] = [];
    try {
      const semUrl =
        `https://api.semanticscholar.org/graph/v1/paper/search` +
        `?query=${encodeURIComponent(keywords)}` +
        `&fields=title,authors,year,abstract,citationCount,externalIds&limit=10`;

      const semRes = await fetch(semUrl, {
        headers: { "User-Agent": "AI-Research-Assistant/1.0" },
        signal: AbortSignal.timeout(10000),
      });

      if (semRes.ok) {
        const semData = await semRes.json();
        rawPapers = semData.data ?? [];
      }
    } catch {
      // 超时或网络错误，尝试 OpenAlex 备用
    }

    // ── 1b. 备用：OpenAlex（Semantic Scholar 挂掉时）────────────────────────
    if (rawPapers.length === 0) {
      try {
        const oaUrl =
          `https://api.openalex.org/works` +
          `?search=${encodeURIComponent(keywords)}` +
          `&select=id,title,authorships,publication_year,abstract_inverted_index,cited_by_count,doi` +
          `&per-page=10&sort=cited_by_count:desc`;

        const oaRes = await fetch(oaUrl, {
          headers: { "User-Agent": "AI-Research-Assistant/1.0" },
          signal: AbortSignal.timeout(10000),
        });

        if (oaRes.ok) {
          const oaData = await oaRes.json();
          rawPapers = (oaData.results ?? []).map((w: {
            id: string;
            title: string;
            authorships: { author: { display_name: string } }[];
            publication_year: number | null;
            abstract_inverted_index: Record<string, number[]> | null;
            cited_by_count: number | null;
            doi: string | null;
          }) => ({
            paperId: w.id,
            title: w.title ?? "",
            authors: (w.authorships ?? []).slice(0, 5).map((a: { author: { display_name: string } }) => ({ name: a.author.display_name })),
            year: w.publication_year ?? null,
            abstract: reconstructAbstract(w.abstract_inverted_index),
            citationCount: w.cited_by_count ?? null,
            externalIds: w.doi ? { DOI: w.doi.replace("https://doi.org/", "") } : null,
          }));
        }
      } catch { /* 两个 API 都失败，返回空 */ }
    }

    if (rawPapers.length === 0) {
      return NextResponse.json({ papers: [], warning: "未找到相关论文，请尝试修改关键词" });
    }

    // ── 2. Claude 批量分析相关性 + 翻译标题 ───────────────────────────────
    const papersText = rawPapers
      .map((p, i) =>
        `[${i + 1}] 标题："${p.title}"\n摘要：${(p.abstract ?? "无摘要").slice(0, 200)}`
      )
      .join("\n\n");

    const claudeRes = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 2000,
        messages: [
          {
            role: "user",
            content: `用户研究课题：「${topic}」

以下是搜索到的 ${rawPapers.length} 篇论文，请对每篇：
1. titleCn：翻译标题为中文（专业术语可保留英文括号标注）
2. relevanceNote：一句话（≤25字）说明与用户课题的具体关联
3. stars：1-5 整数（5=高度相关，与课题直接相关；3=有一定关联；1=几乎无关）

只输出纯 JSON，不要代码块：
{"papers":[{"titleCn":"中文标题","relevanceNote":"关联说明","stars":4}]}

论文列表：
${papersText}`,
          },
        ],
      }),
    });

    let aiAnalysis: { titleCn: string; relevanceNote: string; stars: number }[] =
      rawPapers.map(() => ({ titleCn: "", relevanceNote: "与课题有一定关联", stars: 3 }));

    if (claudeRes.ok) {
      const aiData = await claudeRes.json();
      const aiText: string = aiData.content?.[0]?.text ?? "";
      try {
        const cleaned = aiText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed.papers)) aiAnalysis = parsed.papers;
      } catch { /* 保留默认分析 */ }

      if (userId) {
        insertUsageRecord({
          userId,
          actionType: "keyword_gen",
          tokensInput: aiData.usage?.input_tokens ?? 0,
          tokensOutput: aiData.usage?.output_tokens ?? 0,
        }).catch(() => {});
      }
    }

    const papers: AnalyzedPaper[] = rawPapers.map((p, i) => ({
      paperId: String(p.paperId),
      title: p.title,
      titleCn: aiAnalysis[i]?.titleCn || p.title,
      authors: (p.authors ?? []).map((a) => a.name).slice(0, 4),
      year: p.year ?? null,
      citationCount: p.citationCount ?? null,
      abstract: (p.abstract ?? "").slice(0, 300),
      relevanceNote: aiAnalysis[i]?.relevanceNote || "与课题有关联",
      stars: Math.min(5, Math.max(1, Math.round(aiAnalysis[i]?.stars ?? 3))),
      doi: p.externalIds?.DOI ?? null,
      arxivId: p.externalIds?.ArXiv ?? null,
    }));

    return NextResponse.json({ papers });
  } catch (err) {
    console.error("论文搜索失败:", err);
    return NextResponse.json({ error: "搜索失败，请稍后重试" }, { status: 500 });
  }
}

// OpenAlex 的摘要是倒排索引格式，重建成纯文本
function reconstructAbstract(inv: Record<string, number[]> | null | undefined): string {
  if (!inv) return "";
  const entries = Object.entries(inv).flatMap(([word, positions]) =>
    positions.map((pos) => ({ word, pos }))
  );
  entries.sort((a, b) => a.pos - b.pos);
  return entries.map((e) => e.word).join(" ").slice(0, 500);
}
