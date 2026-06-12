// 后端接口：从 Semantic Scholar 搜索概念相关论文
// 路径：POST /api/concept-explorer/papers
// 中文概念自动翻译成英文再搜索（Semantic Scholar 是英文数据库）

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

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const FIELDS  = "title,authors,year,abstract,citationCount,externalIds";

// 检测是否包含中文字符
function hasChinese(text: string): boolean {
  return /[一-鿿]/.test(text);
}

// 用 Claude 把中文学术概念翻译成英文检索词（轻量调用，max_tokens=60）
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
    return concept; // 翻译失败时退回原词
  }
}

function formatAuthors(raw: { name: string }[]): string {
  if (!raw?.length) return "未知作者";
  if (raw.length <= 3) return raw.map(a => a.name).join(", ");
  return `${raw[0].name} et al.`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPaper(p: any): Paper {
  return {
    paperId:      p.paperId ?? "",
    title:        p.title ?? "无标题",
    authors:      formatAuthors(p.authors ?? []),
    year:         p.year ?? null,
    abstract:     p.abstract ?? null,
    citationCount: p.citationCount ?? 0,
    doi:          p.externalIds?.DOI ?? null,
  };
}

export async function POST(req: NextRequest) {
  try {
    // 验证用户已登录
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

    // 中文概念先翻译成英文，再搜索 Semantic Scholar
    let searchTerm = rawConcept;
    if (hasChinese(rawConcept)) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        searchTerm = await translateToEnglish(rawConcept, apiKey);
        console.log(`[concept-explorer] 翻译: "${rawConcept}" → "${searchTerm}"`);
      }
    }

    const q = encodeURIComponent(searchTerm);
    const headers = { "User-Agent": "AI-Research-Assistant/1.0" };

    if (type === "oldest") {
      const url = `${S2_BASE}/paper/search?query=${q}&fields=${FIELDS}&limit=50`;
      const res = await fetchWithProxy(url, { headers });

      if (!res.ok) return NextResponse.json({ papers: [], searchTerm });

      const data = await res.json();
      const papers: Paper[] = (data.data ?? [])
        .map(toPaper)
        .filter((p: Paper) => p.year !== null)
        .sort((a: Paper, b: Paper) => (a.year ?? 9999) - (b.year ?? 9999))
        .slice(0, 3);

      return NextResponse.json({ papers, searchTerm });
    }

    if (type === "recent") {
      const currentYear = new Date().getFullYear();
      const url = `${S2_BASE}/paper/search?query=${q}&fields=${FIELDS}&limit=50&year=2022-${currentYear}`;

      console.log("[concept/papers] 开始调用 Semantic Scholar API");
      console.log("[concept/papers] 搜索词:", searchTerm);
      console.log("[concept/papers] 请求 URL:", url);

      const res = await fetchWithProxy(url, { headers });

      console.log("[concept/papers] HTTP 状态:", res.status, res.statusText);

      if (!res.ok) {
        const errText = await res.text().catch(() => "(无法读取错误体)");
        console.log("[concept/papers] API 错误:", errText);
        return NextResponse.json({ papers: [], searchTerm });
      }

      const data = await res.json();
      console.log("[concept/papers] API 返回结果 total:", data.total ?? "(无 total 字段)");
      console.log("[concept/papers] data.data 数量:", data.data?.length ?? 0);
      console.log("[concept/papers] 第一条原始数据:", JSON.stringify(data.data?.[0] ?? null));

      const papers: Paper[] = (data.data ?? [])
        .map(toPaper)
        .filter((p: Paper) => (p.year ?? 0) >= 2022)
        .sort((a: Paper, b: Paper) => b.citationCount - a.citationCount)
        .slice(0, 8);

      console.log("[concept/papers] 过滤排序后论文数量:", papers.length);

      return NextResponse.json({ papers, searchTerm });
    }

    return NextResponse.json({ error: "无效的 type 参数" }, { status: 400 });
  } catch (error) {
    console.error("论文搜索异常:", error);
    return NextResponse.json({ papers: [], searchTerm: "" });
  }
}
