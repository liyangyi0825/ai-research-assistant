// 后端接口：从 Semantic Scholar 搜索概念相关论文
// 路径：POST /api/concept-explorer/papers

import { NextRequest, NextResponse } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { getSupabaseAuthClient } from "@/lib/supabase";

export interface Paper {
  paperId: string;
  title: string;
  authors: string;       // 格式化后的作者字符串
  year: number | null;
  abstract: string | null;
  citationCount: number;
  doi: string | null;
}

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const FIELDS  = "title,authors,year,abstract,citationCount,externalIds";

function formatAuthors(raw: { name: string }[]): string {
  if (!raw?.length) return "未知作者";
  if (raw.length <= 3) return raw.map(a => a.name).join(", ");
  return `${raw[0].name} et al.`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPaper(p: any): Paper {
  return {
    paperId:     p.paperId ?? "",
    title:       p.title ?? "无标题",
    authors:     formatAuthors(p.authors ?? []),
    year:        p.year ?? null,
    abstract:    p.abstract ?? null,
    citationCount: p.citationCount ?? 0,
    doi:         p.externalIds?.DOI ?? null,
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

    const q = encodeURIComponent(concept.trim());

    if (type === "oldest") {
      // 搜索全部，按年份升序取最早 3 篇
      const url = `${S2_BASE}/paper/search?query=${q}&fields=${FIELDS}&limit=50`;
      const res = await fetchWithProxy(url, {
        headers: { "User-Agent": "AI-Research-Assistant/1.0" },
      });

      if (!res.ok) {
        return NextResponse.json({ papers: [] });
      }

      const data = await res.json();
      const papers: Paper[] = (data.data ?? [])
        .map(toPaper)
        .filter((p: Paper) => p.year !== null)
        .sort((a: Paper, b: Paper) => (a.year ?? 9999) - (b.year ?? 9999))
        .slice(0, 3);

      return NextResponse.json({ papers });
    }

    if (type === "recent") {
      // 筛选近 3 年，按引用数降序取 Top 8
      const currentYear = new Date().getFullYear();
      const url = `${S2_BASE}/paper/search?query=${q}&fields=${FIELDS}&limit=50&year=2022-${currentYear}`;
      const res = await fetchWithProxy(url, {
        headers: { "User-Agent": "AI-Research-Assistant/1.0" },
      });

      if (!res.ok) {
        return NextResponse.json({ papers: [] });
      }

      const data = await res.json();
      const papers: Paper[] = (data.data ?? [])
        .map(toPaper)
        .filter((p: Paper) => (p.year ?? 0) >= 2022)
        .sort((a: Paper, b: Paper) => b.citationCount - a.citationCount)
        .slice(0, 8);

      return NextResponse.json({ papers });
    }

    return NextResponse.json({ error: "无效的 type 参数" }, { status: 400 });
  } catch (error) {
    console.error("论文搜索异常:", error);
    return NextResponse.json({ papers: [] }); // 出错时返回空数组，前端降级显示
  }
}
