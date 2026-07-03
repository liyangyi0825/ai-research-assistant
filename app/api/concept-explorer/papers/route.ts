// 后端接口：从学术数据库搜索概念相关论文
// 路径：POST /api/concept-explorer/papers
// 中文概念自动翻译成英文再搜索
// - oldest（起源论文）：Semantic Scholar API，按发表年份升序，1990年后 + 学科过滤 + 引用/摘要质量过滤
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
  url: string | null;
  relevanceSummary?: string;
}

// ── OpenAlex（用于 oldest）────────────────────────────────────────────────────
const OA_BASE    = "https://api.openalex.org/works";
const OA_FIELDS  = "id,title,authorships,publication_year,abstract_inverted_index,cited_by_count,doi";
const OA_HEADERS = { "User-Agent": "AI-Research-Assistant/1.0 (mailto:admin@iyanhub.com)" };

// ── Semantic Scholar（用于 recent）───────────────────────────────────────────
const SS_BASE    = "https://api.semanticscholar.org/graph/v1/paper/search";
const SS_FIELDS  = "title,authors,year,abstract,citationCount,externalIds,url";
const SS_HEADERS = { "User-Agent": "AI-Research-Assistant/1.0 (mailto:admin@iyanhub.com)" };

function hasChinese(text: string): boolean {
  return /[一-鿿]/.test(text);
}

// Semantic Scholar fieldsOfStudy 参数的合法取值（用于校验 AI 的判断结果，避免传入非法值导致查询报错）
const ORIGIN_FIELDS_OF_STUDY = [
  "Computer Science", "Medicine", "Chemistry", "Biology", "Materials Science", "Physics",
  "Geology", "Psychology", "Art", "History", "Geography", "Sociology", "Business",
  "Political Science", "Economics", "Philosophy", "Mathematics", "Engineering",
  "Environmental Science", "Agricultural and Food Sciences", "Education", "Law", "Linguistics",
];

// 起源论文检索前，先让 AI 给出最准确的英文学术检索词 + 所属学科（用于 Semantic Scholar 的 fieldsOfStudy 过滤）
async function getOriginSearchQuery(
  concept: string,
  apiKey: string,
): Promise<{ term: string; fieldOfStudy: string | null }> {
  try {
    const res = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        max_tokens: 150,
        temperature: 0.1,
        messages: [{
          role: "user",
          content: `你是学术检索专家。用户想查找学术概念「${concept}」的起源论文。

请给出：
1. term：这个概念最准确的英文学术检索词（2-6个单词，用学术圈真实使用的术语，不要生硬直译）
2. fieldOfStudy：该概念最相关的学科领域，只能从以下列表中选一个（实在无法判断就填 null）：
${ORIGIN_FIELDS_OF_STUDY.join("、")}

只输出纯 JSON，不要代码块，不要任何解释：
{"term":"...","fieldOfStudy":"..."}`,
        }],
      }),
    });
    const data = await res.json();
    const textBlock = data.content?.find((b: { type: string }) => b.type === "text");
    const text = (textBlock?.text ?? "").trim();
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned) as { term?: string; fieldOfStudy?: string | null };
    const term = parsed.term?.trim() || concept;
    const fieldOfStudy = parsed.fieldOfStudy && ORIGIN_FIELDS_OF_STUDY.includes(parsed.fieldOfStudy)
      ? parsed.fieldOfStudy
      : null;
    return { term, fieldOfStudy };
  } catch (e) {
    console.warn("[concept-papers] 起源检索词生成失败，退回原始概念:", e);
    return { term: concept, fieldOfStudy: null };
  }
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
        model: "deepseek-v4-pro",
        max_tokens: 60,
        temperature: 0.1,
        messages: [{
          role: "user",
          content: `将以下中文学术概念翻译成最常用的英文学术检索词（只输出英文词组，不超过6个单词，不加任何解释）：${concept}`,
        }],
      }),
    });
    const data = await res.json();
    const textBlock = data.content?.find((b: { type: string }) => b.type === "text");
    const translated = (textBlock?.text ?? "").trim();
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
  const doi = p.doi ? p.doi.replace("https://doi.org/", "") : null;
  return {
    paperId:       p.id ?? "",
    title:         p.title ?? "无标题",
    authors:       names.length === 0 ? "未知作者" : names.length <= 3 ? names.join(", ") : `${names[0]} et al.`,
    year:          p.publication_year ?? null,
    abstract:      reconstructAbstract(p.abstract_inverted_index),
    citationCount: p.cited_by_count ?? 0,
    doi,
    url:           doi ? `https://doi.org/${doi}` : (p.id ?? null),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toSSPaper(p: any): Paper {
  const names: string[] = (p.authors ?? []).map((a: { name: string }) => a.name).filter(Boolean);
  const doi = p.externalIds?.DOI ?? null;
  return {
    paperId:       p.paperId ?? "",
    title:         p.title ?? "无标题",
    authors:       names.length === 0 ? "未知作者" : names.length <= 3 ? names.join(", ") : `${names[0]} et al.`,
    year:          p.year ?? null,
    abstract:      p.abstract ?? null,
    citationCount: p.citationCount ?? 0,
    doi,
    url:           doi ? `https://doi.org/${doi}` : (p.url ?? null),
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
      const apiKey = (process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_API_KEY);
      if (apiKey) {
        searchTerm = await translateToEnglish(rawConcept, apiKey);
      }
    }
    console.log("[concept-papers] 翻译后英文:", searchTerm);

    const currentYear = new Date().getFullYear();

    // ── oldest：Semantic Scholar，1990年后 + 学科过滤，按年份升序，再做引用/摘要质量过滤 ──
    if (type === "oldest") {
      const apiKey = (process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_API_KEY);
      const { term: originTerm, fieldOfStudy } = apiKey
        ? await getOriginSearchQuery(rawConcept, apiKey)
        : { term: searchTerm, fieldOfStudy: null as string | null };
      console.log("[concept-papers] 起源检索词:", originTerm, "学科:", fieldOfStudy);

      const q = encodeURIComponent(originTerm);
      const fieldParam = fieldOfStudy ? `&fieldsOfStudy=${encodeURIComponent(fieldOfStudy)}` : "";
      const url = `${SS_BASE}?query=${q}&fields=${SS_FIELDS}&limit=20&year=1990-${currentYear}&sort=publicationDate:asc${fieldParam}`;
      console.log("[concept-papers] oldest SS URL:", url);

      let rawPapers: Paper[] = [];
      try {
        const res = await fetchWithProxy(url, { headers: SS_HEADERS });
        console.log("[concept-papers] oldest SS 状态:", res.status);
        if (res.ok) {
          const data = await res.json();
          rawPapers = (data.data ?? []).map(toSSPaper);
        } else {
          const errText = await res.text();
          console.error("[concept-papers] Semantic Scholar oldest 错误:", res.status, errText.slice(0, 200));
        }
      } catch (e) {
        console.warn("[concept-papers] Semantic Scholar oldest 异常:", e);
      }

      // 质量过滤：引用数 > 20、摘要完整、摘要中出现检索词（粗略相关性验证）
      const keywords: string[] = originTerm
        .toLowerCase()
        .split(/\s+/)
        .filter((w: string) => w.length > 2 && !["and", "the", "for", "with", "from"].includes(w));
      const papers = rawPapers
        .filter((p: Paper) =>
          p.year !== null &&
          p.citationCount > 20 &&
          !!p.abstract &&
          (keywords.length === 0 || keywords.some((k: string) => p.abstract!.toLowerCase().includes(k)))
        )
        .sort((a: Paper, b: Paper) => (a.year ?? 0) - (b.year ?? 0))
        .slice(0, 3);

      console.log("[concept-papers] oldest 质量过滤后论文数:", papers.length, "/", rawPapers.length);

      // 过滤后不足 2 篇视为证据不足，不展示低质量结果，也不让 AI 编造
      if (papers.length < 2) {
        return NextResponse.json({ papers: [], searchTerm: originTerm, insufficientEvidence: true });
      }

      return NextResponse.json({ papers, searchTerm: originTerm });
    }

    // ── recent：优先 Semantic Scholar，失败自动切换到 OpenAlex ───────────────
    if (type === "recent") {
      const q = encodeURIComponent(searchTerm);
      const fromYear = currentYear - 5;

      // ---- 第一步：尝试 Semantic Scholar ----
      let ssOk = false;
      let papers: Paper[] = [];

      try {
        // 先查近 5 年
        const urlWithYear = `${SS_BASE}?query=${q}&fields=${SS_FIELDS}&limit=20&year=${fromYear}-${currentYear}`;
        console.log("[concept-papers] recent SS URL (带年份):", urlWithYear);
        let res = await fetchWithProxy(urlWithYear, { headers: SS_HEADERS });
        console.log("[concept-papers] recent SS 状态:", res.status);

        if (!res.ok) {
          // 带年份失败，改查全部年份
          const urlAll = `${SS_BASE}?query=${q}&fields=${SS_FIELDS}&limit=20`;
          res = await fetchWithProxy(urlAll, { headers: SS_HEADERS });
          console.log("[concept-papers] recent SS 全年份状态:", res.status);
        }

        if (res.ok) {
          const data = await res.json();
          papers = (data.data ?? [])
            .map(toSSPaper)
            .filter((p: Paper) => p.year !== null)
            .sort((a: Paper, b: Paper) => b.citationCount - a.citationCount)
            .slice(0, 5);

          // 近 5 年不足 3 篇，再查全部年份
          if (papers.length < 3) {
            const urlAll = `${SS_BASE}?query=${q}&fields=${SS_FIELDS}&limit=20`;
            const res2 = await fetchWithProxy(urlAll, { headers: SS_HEADERS });
            if (res2.ok) {
              const data2 = await res2.json();
              const all = (data2.data ?? [])
                .map(toSSPaper)
                .filter((p: Paper) => p.year !== null)
                .sort((a: Paper, b: Paper) => b.citationCount - a.citationCount)
                .slice(0, 5);
              if (all.length > papers.length) papers = all;
            }
          }

          ssOk = papers.length > 0;
          console.log("[concept-papers] Semantic Scholar 返回论文数:", papers.length);
        }
      } catch (e) {
        console.warn("[concept-papers] Semantic Scholar 异常，切换到 OpenAlex:", e);
      }

      // ---- 第二步：SS 无结果时，用 OpenAlex 按引用数降序兜底 ----
      if (!ssOk) {
        console.log("[concept-papers] SS 无结果，切换到 OpenAlex 兜底");

        // 先查近 5 年高引
        const urlOaRecent = `${OA_BASE}?search=${q}&sort=cited_by_count:desc&per-page=10&filter=publication_year:%3E${fromYear}&select=${OA_FIELDS}`;
        console.log("[concept-papers] recent OA URL (近5年):", urlOaRecent);
        let resOa = await fetchWithProxy(urlOaRecent, { headers: OA_HEADERS });
        console.log("[concept-papers] recent OA 状态:", resOa.status);

        if (resOa.ok) {
          const dataOa = await resOa.json();
          papers = (dataOa.results ?? [])
            .map(toOAPaper)
            .filter((p: Paper) => p.year !== null)
            .slice(0, 5);
        }

        // 近 5 年不足 3 篇，放宽到全部年份
        if (papers.length < 3) {
          console.log("[concept-papers] OA 近5年不足，改查全部年份");
          const urlOaAll = `${OA_BASE}?search=${q}&sort=cited_by_count:desc&per-page=5&select=${OA_FIELDS}`;
          resOa = await fetchWithProxy(urlOaAll, { headers: OA_HEADERS });
          if (resOa.ok) {
            const dataOa2 = await resOa.json();
            const all = (dataOa2.results ?? [])
              .map(toOAPaper)
              .filter((p: Paper) => p.year !== null)
              .slice(0, 5);
            if (all.length > papers.length) papers = all;
          }
        }

        console.log("[concept-papers] OpenAlex 兜底返回论文数:", papers.length);
      }

      console.log("[concept-papers] 最终论文数:", papers.length);
      return NextResponse.json({ papers, searchTerm });
    }

    return NextResponse.json({ error: "无效的 type 参数" }, { status: 400 });
  } catch (error) {
    console.error("[concept-papers] 论文搜索异常:", error);
    return NextResponse.json({ papers: [], searchTerm: "" });
  }
}
