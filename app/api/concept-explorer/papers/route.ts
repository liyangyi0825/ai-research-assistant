// 后端接口：从学术数据库搜索概念相关论文
// 路径：POST /api/concept-explorer/papers
// 中文概念自动翻译成英文再搜索
// - oldest（最早论文）：OpenAlex API，按发表年份升序
// - recent（最新进展）：Semantic Scholar API，按引用数降序

import { NextRequest, NextResponse } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { getSupabaseAuthClient } from "@/lib/supabase";

export interface Paper {
  paperId: string;
  title: string;
  authors: string;
  year: number | null;
  abstract: string | null;
  citationCount: number;
  doi: string | null;
}

// ── OpenAlex（用于 oldest）────────────────────────────────────────────────────
const OA_BASE    = "https://api.openalex.org/works";
const OA_FIELDS  = "id,title,authorships,publication_year,abstract_inverted_index,cited_by_count,doi";
const OA_HEADERS = { "User-Agent": "AI-Research-Assistant/1.0 (mailto:admin@iyanhub.com)" };

// ── Semantic Scholar（用于 recent）───────────────────────────────────────────
const SS_BASE    = "https://api.semanticscholar.org/graph/v1/paper/search";
const SS_FIELDS  = "title,authors,year,abstract,citationCount,externalIds";
const SS_HEADERS = { "User-Agent": "AI-Research-Assistant/1.0 (mailto:admin@iyanhub.com)" };

function hasChinese(text: string): boolean {
  return /[一-鿿]/.test(text);
}

async function translateToEnglish(concept: string, apiKey: string): Promise<string> {
  try {
    const res = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 60,
        temperature: 0.1,
        messages: [{
          role: "user",
          content: `将以下中文学术概念翻译成最常用的英文学术检索词（只输出英文词组，不超过6个单词，不加任何解释）：${concept}`,
        }],
      }),
    });
    const data = await res.json();
    const translated = (data.content?.[0]?.text ?? "").trim();
    return translated || concept;
  } catch {
    return concept;
  }
}

// OpenAlex 摘要以"倒排索引"格式存储，需要还原成普通文本
function reconstructAbstract(invertedIndex: Record<string, number[]> | null): string | null {
  if (!invertedIndex) return null;
  const pairs: [number, string][] = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) pairs.push([pos, word]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs.map(p => p[1]).join(" ") || null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toOAPaper(p: any): Paper {
  const authorships: { author: { display_name: string } }[] = p.authorships ?? [];
  const names = authorships.map(a => a.author?.display_name).filter(Boolean);
  return {
    paperId:       p.id ?? "",
    title:         p.title ?? "无标题",
    authors:       names.length === 0 ? "未知作者" : names.length <= 3 ? names.join(", ") : `${names[0]} et al.`,
    year:          p.publication_year ?? null,
    abstract:      reconstructAbstract(p.abstract_inverted_index),
    citationCount: p.cited_by_count ?? 0,
    doi:           p.doi ? p.doi.replace("https://doi.org/", "") : null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toSSPaper(p: any): Paper {
  const names: string[] = (p.authors ?? []).map((a: { name: string }) => a.name).filter(Boolean);
  return {
    paperId:       p.paperId ?? "",
    title:         p.title ?? "无标题",
    authors:       names.length === 0 ? "未知作者" : names.length <= 3 ? names.join(", ") : `${names[0]} et al.`,
    year:          p.year ?? null,
    abstract:      p.abstract ?? null,
    citationCount: p.citationCount ?? 0,
    doi:           p.externalIds?.DOI ?? null,
  };
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "请先登录" }, { status: 401 });
    }

    const { concept, type } = await req.json();
    if (!concept?.trim()) {
      return NextResponse.json({ error: "请输入概念名称" }, { status: 400 });
    }

    const rawConcept = concept.trim();
    console.log("[concept-papers] 原始概念:", rawConcept);

    let searchTerm = rawConcept;
    if (hasChinese(rawConcept)) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        searchTerm = await translateToEnglish(rawConcept, apiKey);
      }
    }
    console.log("[concept-papers] 翻译后英文:", searchTerm);

    const currentYear = new Date().getFullYear();

    // ── oldest：OpenAlex，按发表年份升序 ────────────────────────────────────
    if (type === "oldest") {
      const q = encodeURIComponent(searchTerm);
      const url = `${OA_BASE}?search=${q}&sort=publication_year:asc&per-page=3&select=${OA_FIELDS}`;
      console.log("[concept-papers] oldest URL:", url);
      const res = await fetchWithProxy(url, { headers: OA_HEADERS });
      console.log("[concept-papers] oldest 状态:", res.status);
      if (!res.ok) {
        const errText = await res.text();
        console.error("[concept-papers] OpenAlex oldest 错误:", res.status, errText.slice(0, 200));
        return NextResponse.json({ papers: [], searchTerm });
      }
      const data = await res.json();
      const papers: Paper[] = (data.results ?? [])
        .map(toOAPaper)
        .filter((p: Paper) => p.year !== null);
      console.log("[concept-papers] oldest API 返回论文数:", papers.length);
      return NextResponse.json({ papers, searchTerm });
    }

    // ── recent：Semantic Scholar，按引用数降序 ───────────────────────────────
    if (type === "recent") {
      const q = encodeURIComponent(searchTerm);
      const fromYear = currentYear - 5;

      // 第一次尝试：限制近 5 年
      const urlWithYear = `${SS_BASE}?query=${q}&fields=${SS_FIELDS}&limit=20&year=${fromYear}-${currentYear}`;
      console.log("[concept-papers] recent URL (带年份):", urlWithYear);
      let res = await fetchWithProxy(urlWithYear, { headers: SS_HEADERS });
      console.log("[concept-papers] recent 状态:", res.status);

      // 如果带年份的请求失败，改查全部年份
      if (!res.ok) {
        console.log("[concept-papers] recent 带年份请求失败，改查全部年份");
        const urlAll = `${SS_BASE}?query=${q}&fields=${SS_FIELDS}&limit=20`;
        res = await fetchWithProxy(urlAll, { headers: SS_HEADERS });
        console.log("[concept-papers] recent 全年份状态:", res.status);
      }

      if (!res.ok) {
        const errText = await res.text();
        console.error("[concept-papers] Semantic Scholar recent 错误:", res.status, errText.slice(0, 200));
        return NextResponse.json({ papers: [], searchTerm });
      }

      const data = await res.json();
      let papers: Paper[] = (data.data ?? [])
        .map(toSSPaper)
        .filter((p: Paper) => p.year !== null)
        .sort((a: Paper, b: Paper) => b.citationCount - a.citationCount)
        .slice(0, 5);

      // 如果近 5 年结果不足 3 篇，再查全部年份补充
      if (papers.length < 3) {
        console.log("[concept-papers] recent 近 5 年结果不足，改查全部年份");
        const urlAll = `${SS_BASE}?query=${q}&fields=${SS_FIELDS}&limit=20`;
        const res2 = await fetchWithProxy(urlAll, { headers: SS_HEADERS });
        if (res2.ok) {
          const data2 = await res2.json();
          papers = (data2.data ?? [])
            .map(toSSPaper)
            .filter((p: Paper) => p.year !== null)
            .sort((a: Paper, b: Paper) => b.citationCount - a.citationCount)
            .slice(0, 5);
        }
      }

      console.log("[concept-papers] API 返回论文数:", papers.length);
      return NextResponse.json({ papers, searchTerm });
    }

    return NextResponse.json({ error: "无效的 type 参数" }, { status: 400 });
  } catch (error) {
    console.error("[concept-papers] 论文搜索异常:", error);
    return NextResponse.json({ papers: [], searchTerm: "" });
  }
}
