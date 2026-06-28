"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Header } from "@/components/Header";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

// ── 类型定义 ───────────────────────────────────────────────────────────────

interface ColumnDef {
  original: string;
  renamed:  string;
  type:     "datetime" | "numeric" | "category" | "text";
}

type CleaningRule =
  | { id: string; type: "drop_empty_rows"; description: string }
  | { id: string; type: "rename_columns";  description: string }
  | { id: string; type: "strip_unit";    column: string; unit: string; description: string }
  | { id: string; type: "drop_missing";  column: string; description: string }
  | { id: string; type: "drop_outliers"; column: string; min: number; max: number; description: string }
  | { id: string; type: "parse_number";  column: string; description: string };

interface ChartSuggestion {
  id:    string;
  type:  "line" | "bar" | "scatter";
  x:     string;
  y:     string[];
  title: string;
}

interface AnalysisResult {
  columns: ColumnDef[];
  issues:  string[];
  rules:   CleaningRule[];
  charts:  ChartSuggestion[];
}

// ── 清洗逻辑（纯函数，在浏览器执行，不上传完整数据）───────────────────────

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyRules(
  headers: string[],
  rows:    string[][],
  columns: ColumnDef[],
  rules:   CleaningRule[],
): { headers: string[]; rows: (string | number)[][] } {
  let h = [...headers];
  let r: (string | number)[][] = rows.map(row => [...row] as (string | number)[]);
  const MISSING = new Set(["", "n/a", "na", "nan", "null", "none", "-", "undefined"]);
  const idx = (col: string) => h.indexOf(col);

  // 保证顺序：先 drop_empty → 再 rename → 再其他
  const sorted: CleaningRule[] = [
    ...rules.filter(x => x.type === "drop_empty_rows"),
    ...rules.filter(x => x.type === "rename_columns"),
    ...rules.filter(x => x.type !== "drop_empty_rows" && x.type !== "rename_columns"),
  ];

  for (const rule of sorted) {
    if (rule.type === "drop_empty_rows") {
      r = r.filter(row => row.some(c => String(c ?? "").trim() !== ""));
    } else if (rule.type === "rename_columns") {
      const map = new Map(columns.map(c => [c.original, c.renamed]));
      h = h.map(name => map.get(name) ?? name);
    } else if (rule.type === "strip_unit") {
      const i = idx(rule.column);
      if (i < 0) continue;
      const re = new RegExp(`\\s*${escapeRe(rule.unit)}\\s*$`, "i");
      r = r.map(row => {
        const raw = String(row[i] ?? "").replace(re, "").trim();
        const n   = parseFloat(raw);
        row[i]    = isNaN(n) ? raw : n;
        return row;
      });
    } else if (rule.type === "parse_number") {
      const i = idx(rule.column);
      if (i < 0) continue;
      r = r.map(row => {
        const n = parseFloat(String(row[i] ?? ""));
        if (!isNaN(n)) row[i] = n;
        return row;
      });
    } else if (rule.type === "drop_missing") {
      const i = idx(rule.column);
      if (i < 0) continue;
      r = r.filter(row => !MISSING.has(String(row[i] ?? "").toLowerCase().trim()));
    } else if (rule.type === "drop_outliers") {
      const i = idx(rule.column);
      if (i < 0) continue;
      r = r.filter(row => {
        const n = parseFloat(String(row[i] ?? ""));
        if (isNaN(n)) return true;
        return n >= rule.min && n <= rule.max;
      });
    }
  }
  return { headers: h, rows: r };
}

// ── 常量 ──────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS       = 100_000;
const SAMPLE_SIZE    = 100;

// ── 辅助组件 ──────────────────────────────────────────────────────────────

function DotLoader() {
  return (
    <span className="inline-flex gap-1 items-center">
      <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
      <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
      <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" />
    </span>
  );
}

function DataTable({
  headers,
  rows,
  maxRows = 50,
}: {
  headers: string[];
  rows: (string | number)[][];
  maxRows?: number;
}) {
  return (
    <div className="overflow-auto rounded-xl border border-gray-200 max-h-60">
      <table className="text-xs min-w-full border-collapse">
        <thead>
          <tr className="bg-gray-50 sticky top-0 z-10">
            {headers.map((h, i) => (
              <th key={i} className="px-3 py-2 text-left font-semibold text-gray-600 border-b border-gray-200 whitespace-nowrap">
                {h || <span className="text-gray-300">(空)</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, maxRows).map((row, i) => (
            <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-gray-50/40"}>
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-1.5 text-gray-700 border-b border-gray-100 whitespace-nowrap max-w-[200px] truncate">
                  {String(cell ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── 主组件 ───────────────────────────────────────────────────────────────

type Phase = "upload" | "preview" | "analyzing" | "plan" | "done";

export default function DataCleanPage() {
  const [phase,          setPhase]          = useState<Phase>("upload");
  const [fileName,       setFileName]       = useState("");
  const [rawHeaders,     setRawHeaders]     = useState<string[]>([]);
  const [rawRows,        setRawRows]        = useState<string[][]>([]);
  const [totalRows,      setTotalRows]      = useState(0);
  const [analysis,       setAnalysis]       = useState<AnalysisResult | null>(null);
  const [enabledRules,   setEnabledRules]   = useState<Set<string>>(new Set());
  const [cleanedHeaders, setCleanedHeaders] = useState<string[]>([]);
  const [cleanedRows,    setCleanedRows]    = useState<(string | number)[][]>([]);
  const [analyzeError,   setAnalyzeError]   = useState("");
  const [activeTab,      setActiveTab]      = useState<"before" | "after">("before");
  const [isRestoredFromDB,   setIsRestoredFromDB]   = useState(false);
  const [truncatedOnRestore, setTruncatedOnRestore] = useState(false);

  // ── 论文图表生成状态 ────────────────────────────────────────────────────────
  const [chartXCol,      setChartXCol]      = useState("");
  const [chartYCols,     setChartYCols]     = useState<string[]>([]);
  const [chartType,      setChartType]      = useState<"line" | "bar" | "scatter">("line");
  const [chartTitle,     setChartTitle]     = useState("");
  const [chartXLabel,    setChartXLabel]    = useState("");
  const [chartYLabel,    setChartYLabel]    = useState("");
  const [chartGenerating,setChartGenerating]= useState(false);
  const [chartPngUrl,    setChartPngUrl]    = useState("");
  const [chartSvgUrl,    setChartSvgUrl]    = useState("");
  const [chartError,     setChartError]     = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  // 页面加载时从 DB 恢复最近一次清洗结果
  useEffect(() => {
    async function init() {
      console.log("[data-clean] 开始从 DB 恢复");
      try {
        const supabase = getSupabaseBrowserClient();
        const { data: { user } } = await supabase.auth.getUser();
        console.log("[data-clean] 恢复-当前用户:", user?.id ?? "未登录");
        if (!user) return;
        const { data, error } = await supabase
          .from("data_clean_sessions")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        console.log("[data-clean] 查询结果:", error ?? "成功", "data:", data ? `file=${data.file_name}` : null);
        if (!data) return;
        const a = data.analysis as AnalysisResult;
        setFileName(data.file_name as string);
        setTotalRows(data.raw_row_count as number);
        setAnalysis(a);
        setEnabledRules(new Set(a.rules.map((r: CleaningRule) => r.id)));
        setCleanedHeaders(data.cleaned_headers as string[]);
        const restoredRows = data.cleaned_data as (string | number)[][];
        setCleanedRows(restoredRows);
        setPhase("done");
        setActiveTab("after");
        setIsRestoredFromDB(true);
        setTruncatedOnRestore((data.cleaned_row_count as number) > restoredRows.length);
      } catch { /* 静默 */ }
    }
    init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 将清洗结果保存到 DB（静默执行，不阻塞 UI）
  async function saveCleanSession(
    h: string[],
    r: (string | number)[][],
    a: AnalysisResult,
    name: string,
    rowCount: number,
    colCount: number,
  ) {
    console.log("[data-clean] 开始保存到 DB");
    try {
      const supabase = getSupabaseBrowserClient();
      const { data: { user } } = await supabase.auth.getUser();
      console.log("[data-clean] 当前用户:", user?.id ?? "未登录");
      if (!user) return;
      const { error } = await supabase.from("data_clean_sessions").insert({
        user_id: user.id,
        file_name: name,
        raw_row_count: rowCount,
        raw_col_count: colCount,
        cleaned_row_count: r.length,
        analysis: a,
        cleaned_headers: h,
        cleaned_data: r.slice(0, 5000),
      });
      console.log("[data-clean] 保存结果:", error ?? "成功");
    } catch (e) {
      console.error("[data-clean] 保存异常:", e);
    }
  }

  // ── 文件解析 ─────────────────────────────────────────────────────────────

  async function handleFile(file: File) {
    if (!file.name.match(/\.(xlsx?|csv)$/i)) {
      toast.error("只支持 .xlsx / .xls / .csv 格式");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      toast.error("文件超过 10MB 限制，请拆分后重试");
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      const wb     = XLSX.read(buffer);
      const ws     = wb.Sheets[wb.SheetNames[0]];
      const raw    = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, defval: "" });

      if (raw.length < 2) { toast.error("文件无有效数据（至少需要标题行 + 1 行数据）"); return; }

      const headers = (raw[0] as (string | number)[]).map(h => String(h ?? "").trim());
      const rows    = (raw.slice(1) as (string | number)[][])
        .map(row => {
          const r = [...row];
          while (r.length < headers.length) r.push("");
          return r.slice(0, headers.length).map(c => String(c ?? "").trim());
        })
        .slice(0, MAX_ROWS);

      if (rows.length === MAX_ROWS) {
        toast("文件超过 10 万行，已截取前 10 万行进行处理");
      }

      setFileName(file.name);
      setRawHeaders(headers);
      setRawRows(rows);
      setTotalRows(rows.length);
      setPhase("preview");
      setAnalysis(null);
      setEnabledRules(new Set());
      setCleanedHeaders([]);
      setCleanedRows([]);
      setAnalyzeError("");
      setActiveTab("before");
    } catch {
      toast.error("文件解析失败，请检查文件格式是否正确");
    }
  }

  function handleReset() {
    setPhase("upload");
    setFileName("");
    setRawHeaders([]);
    setRawRows([]);
    setTotalRows(0);
    setAnalysis(null);
    setEnabledRules(new Set());
    setCleanedHeaders([]);
    setCleanedRows([]);
    setAnalyzeError("");
    setIsRestoredFromDB(false);
    setTruncatedOnRestore(false);
    setChartXCol(""); setChartYCols([]); setChartTitle("");
    setChartXLabel(""); setChartYLabel(""); setChartPngUrl(""); setChartSvgUrl(""); setChartError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // ── AI 分析 ──────────────────────────────────────────────────────────────

  async function handleAnalyze() {
    setPhase("analyzing");
    setAnalyzeError("");
    try {
      const res  = await fetch("/api/data-clean", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          headers,
          sample:    rawRows.slice(0, SAMPLE_SIZE),
          totalRows,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "分析失败");
      const a = data as AnalysisResult;
      setAnalysis(a);
      setEnabledRules(new Set(a.rules.map((r: CleaningRule) => r.id)));
      // 用 AI 推荐的第一个图表预填轴配置
      if (a.charts?.length > 0) {
        const first = a.charts[0];
        setChartXCol(first.x);
        setChartYCols(first.y);
        setChartType(first.type as "line" | "bar" | "scatter");
        setChartTitle(first.title ?? "");
        setChartXLabel(first.x);
        setChartYLabel("");
      }
      setPhase("plan");
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : "分析失败，请重试");
      setPhase("preview");
    }
  }

  // ── 执行清洗 ─────────────────────────────────────────────────────────────

  function handleClean() {
    if (!analysis) return;
    const active = analysis.rules.filter(r => enabledRules.has(r.id));
    const { headers: h, rows: r } = applyRules(rawHeaders, rawRows, analysis.columns, active);
    setCleanedHeaders(h);
    setCleanedRows(r);
    setPhase("done");
    setActiveTab("after");
    setChartPngUrl(""); setChartSvgUrl(""); setChartError("");
    // 用清洗后实际列名预填图表配置，严格过滤不存在的列
    if (analysis.charts?.length > 0) {
      const colSet = new Set(h);
      const first = analysis.charts[0];
      const safeX = colSet.has(first.x) ? first.x : (h[0] ?? "");
      const safeY = first.y.filter(col => colSet.has(col));
      setChartXCol(safeX);
      setChartYCols(safeY);
      setChartType(first.type as "line" | "bar" | "scatter");
      setChartTitle(first.title ?? "");
      setChartXLabel(safeX);
    }
    setIsRestoredFromDB(false);
    setTruncatedOnRestore(false);
    saveCleanSession(h, r, analysis, fileName, totalRows, rawHeaders.length);
  }

  // ── 下载 ─────────────────────────────────────────────────────────────────

  // ── 论文图表生成 ──────────────────────────────────────────────────────────

  async function handleGenerateChart() {
    if (!chartXCol || chartYCols.length === 0) {
      toast.error("请先选择 X 轴和至少一个 Y 轴列");
      return;
    }
    // 发送前再次过滤，确保 y_cols 都在实际数据列里
    const colSet = new Set(cleanedHeaders);
    const safeYCols = chartYCols.filter(c => colSet.has(c));
    if (safeYCols.length === 0) {
      toast.error("所选 Y 轴列在清洗后数据中不存在，请重新勾选");
      return;
    }

    setChartGenerating(true);
    setChartError("");
    setChartPngUrl("");
    setChartSvgUrl("");
    try {
      // 把清洗后数据转成 [{列名: 值}] 格式传给后端
      const dataRows = cleanedRows.map(row => {
        const obj: Record<string, string | number> = {};
        cleanedHeaders.forEach((h, i) => { obj[h] = row[i]; });
        return obj;
      });
      const res = await fetch("/api/generate-chart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data:       dataRows,
          chart_type: chartType,
          x_col:      chartXCol,
          y_cols:     safeYCols,
          title:      chartTitle,
          x_label:    chartXLabel || chartXCol,
          y_label:    chartYLabel,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "生成失败");
      setChartPngUrl(json.pngUrl + "?t=" + Date.now());
      setChartSvgUrl(json.svgUrl);
    } catch (e) {
      setChartError(e instanceof Error ? e.message : "生成失败，请重试");
    } finally {
      setChartGenerating(false);
    }
  }

  function handleDownloadExcel() {
    const ws = XLSX.utils.aoa_to_sheet([cleanedHeaders, ...cleanedRows.map(r => r.map(String))]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "清洗后数据");
    XLSX.writeFile(wb, fileName.replace(/\.[^.]+$/, "") + "_cleaned.xlsx");
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  const headers = rawHeaders; // alias for clarity in JSX

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      <Header title="数据清洗" />

      <main className="flex-1 flex flex-col items-center px-4 sm:px-6 py-6 sm:py-10 pb-24 sm:pb-10">
        <div className="w-full max-w-4xl space-y-4 sm:space-y-5">

          {/* 页面标题 */}
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-800 mb-1">数据清洗工具</h1>
            <p className="text-sm text-gray-500">上传 Excel / CSV，AI 自动识别问题并生成清洗方案</p>
          </div>

          {/* ① 上传区域 */}
          {phase === "upload" && (
            <div
              className="bg-white rounded-2xl border-2 border-dashed border-gray-300 hover:border-blue-400 transition-colors p-8 sm:p-12 text-center cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
              onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
              onDragOver={e => e.preventDefault()}
            >
              <div className="text-5xl mb-3">📊</div>
              <p className="text-base sm:text-lg font-medium text-gray-700 mb-2">点击选择文件，或拖拽到这里</p>
              <p className="text-sm text-gray-400">支持 .xlsx / .xls / .csv，最大 10MB，最多 10 万行</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              />
            </div>
          )}

          {/* 文件信息栏（上传后始终显示） */}
          {phase !== "upload" && (
            <div className="bg-white rounded-2xl p-4 sm:p-5 shadow-sm flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold text-gray-800 truncate">📊 {fileName}</p>
                <p className="text-sm text-gray-400 mt-0.5">
                  共 {totalRows.toLocaleString()} 行 · {isRestoredFromDB ? (analysis?.columns.length ?? "?") : rawHeaders.length} 列
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={handleReset} className="shrink-0">重新上传</Button>
            </div>
          )}

          {/* 恢复提示条 */}
          {isRestoredFromDB && (
            <div className="flex items-center justify-between bg-blue-50 border border-blue-100 rounded-xl px-4 py-2.5">
              <span className="text-sm text-blue-700">✨ 已恢复上次的清洗结果</span>
              <button
                onClick={handleReset}
                className="text-xs text-blue-400 hover:text-blue-600 transition-colors ml-4 shrink-0"
              >
                清空重新开始
              </button>
            </div>
          )}

          {/* ② 原始数据预览 */}
          {(phase === "preview" || phase === "analyzing") && (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="px-4 sm:px-5 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
                <p className="font-semibold text-gray-700 text-sm">原始数据预览（前 50 行）</p>
                <span className="text-xs text-gray-400">共 {totalRows.toLocaleString()} 行</span>
              </div>
              <div className="p-4">
                <DataTable headers={rawHeaders} rows={rawRows as (string | number)[][]} maxRows={50} />
              </div>
            </div>
          )}

          {/* 分析错误提示 */}
          {analyzeError && phase === "preview" && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">
              ❌ {analyzeError}
            </div>
          )}

          {/* ② 分析按钮 */}
          {phase === "preview" && (
            <div className="bg-white rounded-2xl p-5 sm:p-6 text-center shadow-sm border border-blue-100">
              <div className="text-3xl mb-2">🤖</div>
              <h2 className="font-semibold text-gray-800 mb-1">让 AI 分析数据质量</h2>
              <p className="text-sm text-gray-500 mb-4">AI 将识别列含义、发现数据问题、给出清洗方案（每月限 10 次）</p>
              <Button size="lg" className="w-full sm:w-auto" onClick={handleAnalyze}>开始 AI 分析</Button>
            </div>
          )}

          {/* AI 分析中 */}
          {phase === "analyzing" && (
            <div className="bg-white rounded-2xl p-8 text-center shadow-sm">
              <div className="flex justify-center mb-4"><DotLoader /></div>
              <p className="text-base font-medium text-gray-700">AI 正在分析数据结构和质量问题…</p>
              <p className="text-sm text-gray-400 mt-1">通常需要 5-10 秒</p>
            </div>
          )}

          {/* ③ 清洗方案（plan / done 阶段都显示） */}
          {(phase === "plan" || phase === "done") && analysis && (
            <div className="bg-white rounded-2xl shadow-sm border border-amber-100 overflow-hidden">
              <div className="px-4 sm:px-5 py-3 sm:py-4 border-b border-amber-50 bg-amber-50">
                <h2 className="font-semibold text-amber-900">🔍 AI 分析结果</h2>
              </div>
              <div className="p-4 sm:p-5 space-y-4">

                {/* 发现的问题 */}
                {analysis.issues.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">发现的问题</p>
                    <ul className="space-y-1">
                      {analysis.issues.map((issue, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                          <span className="text-amber-500 shrink-0 mt-0.5">⚠</span>
                          {issue}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* 清洗规则（逐条开关） */}
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    清洗规则（共 {analysis.rules.length} 条，可按需关闭）
                  </p>
                  <div className="space-y-2">
                    {analysis.rules.map(rule => (
                      <label key={rule.id} className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors">
                        <input
                          type="checkbox"
                          checked={enabledRules.has(rule.id)}
                          onChange={e => {
                            const next = new Set(enabledRules);
                            e.target.checked ? next.add(rule.id) : next.delete(rule.id);
                            setEnabledRules(next);
                          }}
                          className="w-4 h-4 accent-blue-500 shrink-0"
                        />
                        <div className="min-w-0">
                          <span className="text-xs font-mono text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded mr-2">
                            {rule.type}
                          </span>
                          <span className="text-sm text-gray-700">{rule.description}</span>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>

                {phase === "plan" && (
                  <Button
                    className="w-full"
                    onClick={handleClean}
                    disabled={enabledRules.size === 0}
                  >
                    ✅ 执行清洗（已选 {enabledRules.size} 条规则）
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* ④ 清洗前后对比 */}
          {phase === "done" && (
            <div className="bg-white rounded-2xl shadow-sm border border-green-100 overflow-hidden">
              <div className="px-4 sm:px-5 py-3 sm:py-4 border-b border-green-50 bg-green-50 flex items-center justify-between">
                <h2 className="font-semibold text-green-900">✅ 清洗完成</h2>
                <span className="text-sm text-green-700">
                  {isRestoredFromDB
                    ? <>已清洗 {cleanedRows.length.toLocaleString()} 行{truncatedOnRestore && <span className="text-amber-600 ml-1">（超 5000 行仅恢复前 5000 行）</span>}</>
                    : <>{rawRows.length} 行 → {cleanedRows.length} 行{rawRows.length - cleanedRows.length > 0 && <span className="text-green-500 ml-1">（删除 {rawRows.length - cleanedRows.length} 行）</span>}</>
                  }
                </span>
              </div>

              {/* 前/后 Tab */}
              <div className="flex border-b border-gray-100">
                {(["before", "after"] as const).map(tab => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                      activeTab === tab
                        ? "text-blue-600 border-b-2 border-blue-500 bg-blue-50/30"
                        : "text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    {tab === "before"
                      ? (isRestoredFromDB ? "清洗前（未保存）" : `清洗前（${rawRows.length} 行）`)
                      : `清洗后（${cleanedRows.length} 行）`}
                  </button>
                ))}
              </div>

              <div className="p-4">
                {activeTab === "before"
                  ? rawRows.length > 0
                    ? <DataTable headers={rawHeaders} rows={rawRows as (string | number)[][]} maxRows={100} />
                    : <p className="text-sm text-gray-400 text-center py-6">原始数据未保存，如需对比请重新上传文件</p>
                  : <DataTable headers={cleanedHeaders} rows={cleanedRows} maxRows={100} />
                }
              </div>

              <div className="px-4 pb-4">
                <Button onClick={handleDownloadExcel} className="w-full sm:w-auto bg-green-600 hover:bg-green-700 text-white">
                  ⬇ 下载清洗后的 Excel
                </Button>
              </div>
            </div>
          )}

          {/* ⑤ 论文图表生成 */}
          {phase === "done" && cleanedHeaders.length > 0 && (
            <div className="bg-white rounded-2xl shadow-sm border border-indigo-100 overflow-hidden">
              <div className="px-4 sm:px-5 py-3 sm:py-4 border-b border-indigo-50 bg-indigo-50">
                <h2 className="font-semibold text-indigo-900">📈 论文图表生成</h2>
                <p className="text-xs text-indigo-500 mt-0.5">基于清洗后数据，生成可发表的高质量图表（300 DPI）</p>
              </div>

              <div className="p-4 sm:p-5 space-y-4">
                {/* 轴配置区 */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* 图表类型 */}
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 mb-1">图表类型</label>
                    <select
                      value={chartType}
                      onChange={e => setChartType(e.target.value as "line" | "bar" | "scatter")}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                    >
                      <option value="line">折线图</option>
                      <option value="bar">柱状图</option>
                      <option value="scatter">散点图</option>
                    </select>
                  </div>

                  {/* X 轴 */}
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 mb-1">X 轴列</label>
                    <select
                      value={chartXCol}
                      onChange={e => setChartXCol(e.target.value)}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                    >
                      <option value="">-- 选择 X 轴 --</option>
                      {cleanedHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>

                  {/* X 轴标签 */}
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 mb-1">X 轴标签（可选）</label>
                    <input
                      type="text"
                      value={chartXLabel}
                      onChange={e => setChartXLabel(e.target.value)}
                      placeholder={chartXCol || "例：时间（小时）"}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                    />
                  </div>

                  {/* Y 轴标签 */}
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 mb-1">Y 轴标签（可选）</label>
                    <input
                      type="text"
                      value={chartYLabel}
                      onChange={e => setChartYLabel(e.target.value)}
                      placeholder="例：电力负荷 (MW)"
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                    />
                  </div>

                  {/* 图表标题 */}
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-semibold text-gray-500 mb-1">图表标题（可选）</label>
                    <input
                      type="text"
                      value={chartTitle}
                      onChange={e => setChartTitle(e.target.value)}
                      placeholder="例：三天电力负荷趋势对比"
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                    />
                  </div>
                </div>

                {/* Y 轴多选 */}
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-2">
                    Y 轴列（可多选，已选 {chartYCols.length} 列）
                  </label>
                  <div className="flex flex-wrap gap-2 max-h-36 overflow-y-auto p-1">
                    {[...new Set(cleanedHeaders.filter(h => h !== chartXCol))].map(h => {
                      const checked = chartYCols.includes(h);
                      return (
                        <label
                          key={h}
                          title={h}
                          className={`flex items-start gap-1.5 px-3 py-1.5 rounded-lg border text-xs cursor-pointer transition-colors break-all ${
                            checked
                              ? "border-indigo-400 bg-indigo-50 text-indigo-700 font-medium"
                              : "border-gray-200 text-gray-600 hover:border-indigo-200"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={e => {
                              setChartYCols(prev =>
                                e.target.checked ? [...prev, h] : prev.filter(c => c !== h)
                              );
                            }}
                            className="w-3 h-3 mt-0.5 accent-indigo-500 shrink-0"
                          />
                          {h}
                        </label>
                      );
                    })}
                  </div>
                </div>

                {/* 生成按钮 */}
                <Button
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-white"
                  onClick={handleGenerateChart}
                  disabled={chartGenerating || !chartXCol || chartYCols.length === 0}
                >
                  {chartGenerating ? (
                    <span className="inline-flex items-center gap-2"><DotLoader /> 生成中，请稍候…</span>
                  ) : "🎨 生成论文图表"}
                </Button>

                {/* 错误提示 */}
                {chartError && (
                  <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">
                    ❌ {chartError}
                  </div>
                )}

                {/* 预览区 */}
                {chartPngUrl && (
                  <div className="space-y-3">
                    <p className="text-xs font-semibold text-gray-500">预览（点击可放大）</p>
                    <a href={chartPngUrl} target="_blank" rel="noreferrer">
                      <img
                        src={chartPngUrl}
                        alt="论文图表预览"
                        className="w-full rounded-xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow"
                      />
                    </a>
                    <div className="flex gap-2">
                      <a
                        href={chartPngUrl}
                        download
                        className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        ⬇ 下载 PNG（300 DPI）
                      </a>
                      <a
                        href={chartSvgUrl}
                        download
                        className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        ⬇ 下载 SVG（矢量）
                      </a>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

        </div>
      </main>
    </div>
  );
}
