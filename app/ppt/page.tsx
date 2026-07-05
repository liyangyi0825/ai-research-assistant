"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { PptSlidePreview } from "@/components/PptSlidePreview";
import { Header } from "@/components/Header";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { PPT_TEMPLATES, TEMPLATE_LIST, DEFAULT_TEMPLATE, type TemplateId } from "@/lib/pptTemplates";

function DotLoader() {
  return (
    <span className="inline-flex gap-1 items-center">
      <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
      <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
      <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" />
    </span>
  );
}

type UploadStage = "idle" | "uploading" | "done" | "error";
type PptStatus = "idle" | "selecting" | "loading" | "done" | "error";

export default function PptPage() {
  // PDF 提取
  const [uploadStage, setUploadStage] = useState<UploadStage>("idle");
  const [uploadProgress, setUploadProgress] = useState<"uploading" | "extracting">("uploading");
  const [extractedText, setExtractedText] = useState("");
  const [fileName, setFileName] = useState("");
  const [uploadError, setUploadError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // PPT 生成
  const [pptStatus, setPptStatus] = useState<PptStatus>("idle");
  const [pptScene, setPptScene] = useState<"defense" | "meeting" | null>(null);
  const [templateId, setTemplateId] = useState<TemplateId>(DEFAULT_TEMPLATE);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [pptContent, setPptContent] = useState<any>(null);
  const [pptError, setPptError] = useState("");
  const [pptDownloading, setPptDownloading] = useState(false);

  // 刷新恢复
  const [showRestoreBanner, setShowRestoreBanner] = useState(false);
  const [restoredScene, setRestoredScene] = useState<"defense" | "meeting" | null>(null);
  const [restoredIsComplete, setRestoredIsComplete] = useState(false);
  const [restoredPptTitle, setRestoredPptTitle] = useState<string | null>(null);
  const [restoredTotalSlides, setRestoredTotalSlides] = useState<number | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const pptIdRef = useRef<string | null>(null);
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

  // 获取当前用户 ID（浏览器端，不走 API）
  useEffect(() => {
    getSupabaseBrowserClient().auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null);
    });
  }, []);

  // userId 就绪后恢复上次状态
  useEffect(() => {
    if (!userId) return;
    const raw = localStorage.getItem(`iyanhub_ppt_${userId}`);
    if (!raw) return;
    try {
      const data = JSON.parse(raw) as {
        fileName: string;
        paperContent: string;
        pptScene: "defense" | "meeting" | null;
        isComplete?: boolean;
        pptTitle?: string;
        totalSlides?: number;
        pptId?: string;
        timestamp: number;
      };
      if (Date.now() - data.timestamp > SEVEN_DAYS) {
        localStorage.removeItem(`iyanhub_ppt_${userId}`);
        return;
      }
      if (!data.fileName || !data.paperContent) return;
      setFileName(data.fileName);
      setExtractedText(data.paperContent);
      setUploadStage("done");
      setRestoredScene(data.pptScene ?? null);
      setRestoredIsComplete(data.isComplete ?? false);
      setRestoredPptTitle(data.pptTitle ?? null);
      setRestoredTotalSlides(data.totalSlides ?? null);

      // 如果有 pptId，从 Supabase 拉取完整幻灯片内容并直接恢复
      if (data.pptId && data.isComplete) {
        pptIdRef.current = data.pptId;
        fetch(`/api/ppt/sessions?pptId=${encodeURIComponent(data.pptId)}`)
          .then(r => r.json())
          .then((res: { ppt?: { scene: string; ppt_data: unknown } | null }) => {
            if (res.ppt?.ppt_data) {
              setPptScene(res.ppt.scene as "defense" | "meeting");
              setPptContent(res.ppt.ppt_data);
              setPptStatus("done");
              setUploadStage("done");
              // 不显示 banner，直接展示结果
            } else {
              // 拉取失败，降级到 banner + 重新生成
              setPptStatus("selecting");
              setShowRestoreBanner(true);
            }
          })
          .catch(() => {
            setPptStatus("selecting");
            setShowRestoreBanner(true);
          });
      } else {
        setPptStatus("selecting");
        setShowRestoreBanner(true);
      }
    } catch { /* 静默 */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // 上传/场景/生成完成时保存——paperContent 限 10000 字符，防止 localStorage 超限
  useEffect(() => {
    if (!fileName || !extractedText || !userId) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = pptContent as any;
    try {
      localStorage.setItem(`iyanhub_ppt_${userId}`, JSON.stringify({
        fileName,
        paperContent: extractedText.slice(0, 10000),
        pptScene: pptScene ?? null,
        isComplete: pptStatus === "done",
        pptTitle: content?.title ?? null,
        totalSlides: content?.total_pages ?? null,
        pptId: pptIdRef.current ?? null,
        timestamp: Date.now(),
      }));
    } catch { /* 静默 */ }
  }, [fileName, extractedText, pptScene, pptStatus, pptContent, userId]);

  async function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setUploadError("请上传 PDF 格式的文件");
      setUploadStage("error");
      return;
    }
    setFileName(file.name);
    setUploadError("");
    setUploadStage("uploading");
    setUploadProgress("uploading");
    setPptStatus("idle");
    setPptContent(null);

    const stageTimer = setTimeout(() => setUploadProgress("extracting"), 1500);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/extract", { method: "POST", body: formData });
      clearTimeout(stageTimer);

      let data: { text?: string; error?: string };
      try {
        data = await res.json();
      } catch {
        if (res.status === 413) throw new Error("PDF 文件太大（最大 50MB），请压缩后重试");
        throw new Error(`服务器错误（HTTP ${res.status}）`);
      }
      if (!res.ok) throw new Error(data.error || "解析失败");
      setExtractedText(data.text ?? "");
      setUploadStage("done");
      setPptStatus("selecting");
      // 保存论文记录
      fetch("/api/my-papers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title:    file.name.replace(/\.pdf$/i, ""),
          content:  data.text ?? "",
          fileSize: file.size,
        }),
      }).catch(() => {});
    } catch (err) {
      clearTimeout(stageTimer);
      setUploadError(err instanceof Error ? err.message : "上传失败，请重试");
      setUploadStage("error");
    }
  }

  function handleReset() {
    if (userId) try { localStorage.removeItem(`iyanhub_ppt_${userId}`); } catch { /* 静默 */ }
    pptIdRef.current = null;
    setUploadStage("idle");
    setExtractedText("");
    setFileName("");
    setUploadError("");
    setPptStatus("idle");
    setPptScene(null);
    setPptContent(null);
    setPptError("");
    setShowRestoreBanner(false);
    setRestoredScene(null);
    setRestoredIsComplete(false);
    setRestoredPptTitle(null);
    setRestoredTotalSlides(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handlePptGenerate(scene: "defense" | "meeting") {
    setPptScene(scene);
    setPptStatus("loading");
    setPptError("");
    setPptContent(null);
    try {
      const res = await fetch("/api/ppt/generate-content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paperContent: extractedText, scene }),
      });

      if (!res.ok) {
        let errorMsg = `服务器错误（${res.status}），请重试`;
        try {
          const errData = await res.json() as { error?: string };
          if (errData.error) errorMsg = errData.error;
        } catch { /* 保留通用错误信息 */ }
        console.error("PPT API 错误:", res.status, errorMsg);
        throw new Error(errorMsg);
      }
      if (!res.body) throw new Error("服务器响应为空，请重试");

      // 读取 SSE 流，等待最终 data 事件
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";
      let result: { pptContent?: unknown; error?: string } | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          try { result = JSON.parse(raw); } catch { /* 跳过心跳注释等非 JSON 行 */ }
        }
      }

      if (!result) throw new Error("生成失败，请重试");
      if (result.error) throw new Error(result.error);
      setPptContent(result.pptContent);
      setPptStatus("done");

      // 保存到 Supabase（fire-and-forget，失败不影响主流程）
      fetch("/api/ppt/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName, scene, pptData: result.pptContent }),
      })
        .then(r => r.json())
        .then((res: { id?: string }) => {
          if (res.id) pptIdRef.current = res.id;
        })
        .catch(() => {});
    } catch (err) {
      setPptError(err instanceof Error ? err.message : "生成失败，请重试");
      setPptStatus("error");
    }
  }

  async function handlePptDownload() {
    if (!pptContent || pptDownloading) return;
    setPptDownloading(true);
    try {
      const res = await fetch("/api/ppt/generate-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pptContent, templateId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || "下载失败");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${pptContent.title || "演示文稿"}.pptx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err instanceof Error ? err.message : "下载失败，请重试");
    } finally {
      setPptDownloading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'linear-gradient(to bottom right, #EFF6FF, #E0E7FF)' }}>
      <Header title="论文转 PPT" />

      <main className="flex-1 flex flex-col items-center px-4 sm:px-6 py-6 sm:py-12 pb-24 sm:pb-12">
        <div className="w-full max-w-3xl space-y-5">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-800 mb-1">🎯 论文转 PPT</h1>
            <p className="text-sm sm:text-base text-gray-500">
              上传 PDF 论文，AI 自动提取数据与结论，生成结构完整的幻灯片
            </p>
          </div>

          {/* 恢复 Banner */}
          {showRestoreBanner && (
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 space-y-3">
              <div>
                <p className="text-sm text-blue-700">
                  ✨ 已恢复上次的论文：<span className="font-medium">{fileName.replace(/\.pdf$/i, "")}</span>
                </p>
                {restoredScene && (
                  <p className="text-xs text-blue-500 mt-0.5">
                    场景：{restoredScene === "defense" ? "🎓 毕业/学位答辩" : "📊 组会/进展汇报"}
                  </p>
                )}
                {restoredIsComplete && restoredPptTitle && (
                  <p className="text-xs text-green-600 mt-0.5">
                    ✓ 上次已完成生成：{restoredPptTitle}
                    {restoredTotalSlides ? `，共 ${restoredTotalSlides} 页` : ""}
                  </p>
                )}
                {!restoredIsComplete && restoredScene && (
                  <p className="text-xs text-amber-600 mt-0.5">上次未完成生成，点击重新生成</p>
                )}
              </div>
              <div className="flex gap-2 flex-wrap">
                {restoredScene && (
                  <Button
                    size="sm"
                    onClick={() => {
                      setShowRestoreBanner(false);
                      handlePptGenerate(restoredScene);
                    }}
                  >
                    重新生成 PPT
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={handleReset}>
                  上传新论文
                </Button>
              </div>
            </div>
          )}

          {/* 上传区 */}
          {(uploadStage === "idle" || uploadStage === "error") && (
            <div
              className="bg-white rounded-2xl border-2 border-dashed border-gray-300 hover:border-blue-400 transition-colors p-8 sm:p-12 text-center cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
              onDragOver={(e) => e.preventDefault()}
            >
              <div className="text-5xl mb-3">📊</div>
              <p className="text-base sm:text-lg font-medium text-gray-700 mb-2">
                点击选择文件，或拖拽 PDF 到这里
              </p>
              <p className="text-sm text-gray-400">支持 PDF 格式，最大 50MB</p>
              {uploadStage === "error" && (
                <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
                  ❌ {uploadError}
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              />
            </div>
          )}

          {/* 上传/提取中 */}
          {uploadStage === "uploading" && (
            <div className="bg-white rounded-2xl p-8 sm:p-12 text-center shadow-sm">
              <div className="text-5xl mb-5">
                {uploadProgress === "uploading" ? "📤" : "📄"}
              </div>
              <div className="flex items-center justify-center gap-2 mb-4">
                <div className={`flex items-center gap-1.5 text-sm font-medium ${uploadProgress === "uploading" ? "text-blue-600" : "text-green-500"}`}>
                  {uploadProgress === "uploading" ? <DotLoader /> : <span>✓</span>}
                  <span>正在上传</span>
                </div>
                <span className="text-gray-300">→</span>
                <div className={`flex items-center gap-1.5 text-sm font-medium ${uploadProgress === "extracting" ? "text-blue-600" : "text-gray-300"}`}>
                  {uploadProgress === "extracting" && <DotLoader />}
                  <span>提取文字</span>
                </div>
              </div>
              <p className="text-sm text-gray-400 truncate px-4">{fileName}</p>
            </div>
          )}

          {/* 提取成功后的后续流程 */}
          {uploadStage === "done" && (
            <>
              {/* 文件信息栏 */}
              <div className="bg-white rounded-2xl p-4 sm:p-5 shadow-sm flex items-start sm:items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-800 truncate">✅ {fileName}</p>
                  <p className="text-sm text-gray-400 mt-0.5">已提取 {extractedText.length.toLocaleString()} 个字符</p>
                </div>
                <Button variant="outline" size="sm" onClick={handleReset} className="shrink-0">
                  重新上传
                </Button>
              </div>

              {/* PPT 区域 */}
              <div className="bg-white rounded-2xl shadow-sm border border-indigo-100 overflow-hidden">
                <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-indigo-50 bg-indigo-50">
                  <h2 className="font-semibold text-indigo-800">📊 生成 PPT 幻灯片</h2>
                </div>

                <div className="p-4 sm:p-6 space-y-4">
                  {/* 模板选择 */}
                  {pptStatus === "selecting" && (
                    <div>
                      <p className="text-sm font-medium text-gray-700 mb-2">选择视觉模板</p>
                      <div className="grid grid-cols-3 gap-3">
                        {TEMPLATE_LIST.map(t => {
                          const p = PPT_TEMPLATES[t.id];
                          const selected = templateId === t.id;
                          return (
                            <button
                              key={t.id}
                              onClick={() => setTemplateId(t.id)}
                              className={`text-left p-2 rounded-xl border-2 transition-all ${selected ? "border-indigo-500 bg-indigo-50" : "border-gray-200 hover:border-indigo-300"}`}
                            >
                              <div
                                className="w-full rounded-md overflow-hidden mb-2"
                                style={{ height: 48, background: `#${p.BG}`, position: "relative" }}
                              >
                                <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 16, background: `#${p.NAVY}` }} />
                                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, background: `#${p.GOLD}` }} />
                              </div>
                              <div className="text-xs font-semibold text-gray-700">{t.name}</div>
                              <div className="text-[11px] text-gray-400 leading-snug">{t.desc}</div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* 场景选择 */}
                  {pptStatus === "selecting" && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <button
                        onClick={() => handlePptGenerate("defense")}
                        className="group text-left p-4 rounded-xl border-2 border-blue-100 hover:border-blue-400 hover:bg-blue-50 transition-all"
                      >
                        <div className="text-2xl mb-2">🎓</div>
                        <div className="font-semibold text-gray-800 text-sm mb-1">毕业 / 学位答辩</div>
                        <div className="text-xs text-gray-500 leading-relaxed">
                          正式学术风格，深蓝色调<br />AI 自动决定页数（通常 10–13 页）
                        </div>
                        <div className="mt-2 text-xs text-blue-600 font-medium opacity-0 group-hover:opacity-100 transition-opacity">点击选择 →</div>
                      </button>
                      <button
                        onClick={() => handlePptGenerate("meeting")}
                        className="group text-left p-4 rounded-xl border-2 border-green-100 hover:border-green-400 hover:bg-green-50 transition-all"
                      >
                        <div className="text-2xl mb-2">📊</div>
                        <div className="font-semibold text-gray-800 text-sm mb-1">组会 / 进展汇报</div>
                        <div className="text-xs text-gray-500 leading-relaxed">
                          简洁汇报风格，清爽简约<br />AI 自动决定页数（通常 7–10 页）
                        </div>
                        <div className="mt-2 text-xs text-green-600 font-medium opacity-0 group-hover:opacity-100 transition-opacity">点击选择 →</div>
                      </button>
                    </div>
                  )}

                  {/* 生成中 */}
                  {pptStatus === "loading" && (
                    <div className="text-center py-8">
                      <div className="flex justify-center mb-3"><DotLoader /></div>
                      <p className="text-sm text-gray-600">AI 正在规划幻灯片结构…</p>
                      <p className="text-xs text-gray-400 mt-1">通常需要 10–20 秒</p>
                    </div>
                  )}

                  {/* 生成失败 */}
                  {pptStatus === "error" && (
                    <div className="space-y-3">
                      <div className="p-3 bg-red-50 border border-red-100 rounded-lg text-red-500 text-sm">❌ {pptError}</div>
                      <Button size="sm" variant="outline" onClick={() => setPptStatus("selecting")}>重新选择场景</Button>
                    </div>
                  )}

                  {/* 生成完成 */}
                  {pptStatus === "done" && pptContent && (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold text-gray-700">
                          ✅ {pptScene === "defense" ? "🎓 答辩版" : "📊 组会版"} · 共 {pptContent.slides?.length ?? pptContent.total_pages} 页
                        </p>
                        <Button size="sm" variant="outline" onClick={() => setPptStatus("selecting")} className="text-xs">
                          换场景
                        </Button>
                      </div>

                      <PptSlidePreview pptContent={pptContent} paperContent={extractedText} templateId={templateId} />

                      <Button
                        onClick={handlePptDownload}
                        disabled={pptDownloading}
                        className="w-full bg-indigo-600 hover:bg-indigo-700 text-white"
                      >
                        {pptDownloading ? "正在生成 PPTX…" : "⬇ 下载 PPTX 文件"}
                      </Button>

                      {pptContent.slides?.some((s: { type: string }) => s.type === "figure") && (
                        <p className="text-xs text-gray-400 text-center leading-relaxed">
                          💡 图表页已预留占位框，下载后在对应页面插入你的实验图即可
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
