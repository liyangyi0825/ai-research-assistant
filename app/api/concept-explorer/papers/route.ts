// 后端接口：从 OpenAlex 搜索概念相关论文
// 路径：POST /api/concept-explorer/papers
// 中文概念自动翻译成英文再搜索（OpenAlex 是英文数据库）

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

const OA_BASE = "https://api.openalex.org/works";
const OA_FIELDS = "id,title,authorships,publication_year,abstract_inverted_index,cited_by_count,doi";
const OA_HEADERS = { "User-Agent": "AI-Research-Assistant/1.0 (mailto:admin@iyanhub.com)" };

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

function formatAuthors(authorships: { author: { display_name: string } }[]): string {
  if (!authorships?.length) return "未知作者";
  const names = authorships.map(a => a.author?.display_name).filter(Boolean);
  if (names.length <= 3) return names.join(", ");
  return `${names[0]} et al.`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toOAPaper(p: any): Paper {
  return {
    paperId:       p.id ?? "",
    title:         p.title ?? "无标题",
    authors:       formatAuthors(p.authorships ?? []),
    year:          p.publication_year ?? null,
    abstract:      reconstructAbstract(p.abstract_inverted_index),
    citationCount: p.cited_by_count ?? 0,
    doi:           p.doi ? p.doi.replace("https://doi.org/", "") : null,
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

    let searchTerm = rawConcept;
    if (hasChinese(rawConcept)) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        searchTerm = await translateToEnglish(rawConcept, apiKey);
        console.log(`[concept-explorer] 翻译: "${rawConcept}" → "${searchTerm}"`);
      }
    }

    const q = encodeURIComponent(searchTerm);
    const currentYear = new Date().getFullYear();

    if (type === "oldest") {
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
      console.log("[concept-papers] oldest 返回:", JSON.stringify(data).slice(0, 300));
      const papers: Paper[] = (data.results ?? [])
        .map(toOAPaper)
        .filter((p: Paper) => p.year !== null);
      return NextResponse.json({ papers, searchTerm });
    }

    if (type === "recent") {
      const year3 = currentYear - 3;
      const year5 = currentYear - 5;

      // 先试近 3 年
      const url3 = `${OA_BASE}?search=${q}&filter=publication_year:${year3}-${currentYear}&sort=cited_by_count:desc&per-page=8&select=${OA_FIELDS}`;
      console.log("[concept-papers] recent url3:", url3);
      const res3 = await fetchWithProxy(url3, { headers: OA_HEADERS });
      console.log("[concept-papers] recent 3y 状态:", res3.status);

      if (res3.ok) {
        const data3 = await res3.json();
        console.log("[concept-papers] recent 3y 返回:", JSON.stringify(data3).slice(0, 300));
        const papers3: Paper[] = (data3.results ?? []).map(toOAPaper).filter((p: Paper) => p.year !== null);
        if (papers3.length >= 3) {
          return NextResponse.json({ papers: papers3, searchTerm });
        }
      }

      // 近 3 年不足 3 条，放宽到近 5 年
      const url5 = `${OA_BASE}?search=${q}&filter=publication_year:${year5}-${currentYear}&sort=cited_by_count:desc&per-page=8&select=${OA_FIELDS}`;
      console.log("[concept-papers] recent url5:", url5);
      const res5 = await fetchWithProxy(url5, { headers: OA_HEADERS });
      console.log("[concept-papers] recent 5y 状态:", res5.status);
      if (!res5.ok) {
        const errText = await res5.text();
        console.error("[concept-papers] OpenAlex recent 错误:", res5.status, errText.slice(0, 200));
        return NextResponse.json({ papers: [], searchTerm });
      }
      const data5 = await res5.json();
      console.log("[concept-papers] recent 5y 返回:", JSON.stringify(data5).slice(0, 300));
      const papers5: Paper[] = (data5.results ?? []).map(toOAPaper).filter((p: Paper) => p.year !== null);
      return NextResponse.json({ papers: papers5, searchTerm });
    }

    return NextResponse.json({ error: "无效的 type 参数" }, { status: 400 });
  } catch (error) {
    console.error("论文搜索异常:", error);
    return NextResponse.json({ papers: [], searchTerm: "" });
  }
}
