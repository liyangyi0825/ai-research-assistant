"use client";

import { useState, useRef, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { MarkdownContent } from "@/components/MarkdownContent";
import { Header } from "@/components/Header";
import { TranslationView } from "@/components/TranslationView";
import { toast } from "sonner";
import { PptSlidePreview } from "@/components/PptSlidePreview";

// ─── 解析 Anthropic SSE 流，逐块 yield 文字 ───────────────────────────────
async function* streamAnthropicSSE(response: Response): AsyncGenerator<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE 每行一个字段，事件之间用空行分隔；这里逐行处理
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // 保留最后一段不完整的行

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (!data || data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          // Anthropic 流式格式：content_block_delta 事件里的 text_delta
          if (
            parsed.type === "content_block_delta" &&
            parsed.delta?.type === "text_delta" &&
            typeof parsed.delta.text === "string"
          ) {
            yield parsed.delta.text;
          }
        } catch {
          // 跳过无法解析的行
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── 解析总结文字，拆成四个部分 ──────────────────────────────────────────────
function parseSummary(text: string) {
  const sections = [
    { key: "研究问题", icon: "🔍" },
    { key: "研究方法", icon: "🔬" },
    { key: "主要结论", icon: "📊" },
    { key: "创新点",   icon: "💡" },
  ];
  return sections.map(({ key, icon }) => {
    const regex = new RegExp(`【${key}】([\\s\\S]*?)(?=【|$)`);
    const match = text.match(regex);
    const content = match ? match[1].trim() : "（未能提取该部分）";
    return { key, icon, content };
  });
}

// ─── 三点加载动画组件 ─────────────────────────────────────────────────────────
function DotLoader() {
  return (
    <span className="inline-flex gap-1 items-center">
      <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
      <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
      <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" />
    </span>
  );
}

interface Message {
  role: "user" | "assistant";
  content: string;
}

function UploadPageInner() {
  const searchParams = useSearchParams();

  // ── PDF 提取状态 ──
  const [extractStatus, setExtractStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [uploadStage, setUploadStage] = useState<"uploading" | "extracting">("uploading");
  const [extractedText, setExtractedText] = useState("");
  const [extractError, setExtractError] = useState("");
  const [fileName, setFileName] = useState("");

  // (no paper-id ref needed — we don't track per-feature usage)

  // ── AI 总结状态 ──
  // loading = 等待第一个 token；streaming = 文字正在流入；done = 完成
  const [summaryStatus, setSummaryStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [summaryText, setSummaryText] = useState("");
  const [summaryError, setSummaryError] = useState("");
  const summaryStreamId = useRef(0); // 防止旧流覆盖新流

  // ── 对话状态 ──
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatStreamId = useRef(0);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── 论文 ID（用于保存笔记时记录来源）──
  const [paperId, setPaperId] = useState<string | null>(null);

  // ── 总结历史加载状态 ──
  const [summaryFromDB, setSummaryFromDB]       = useState(false);
  const [summaryUpdatedAt, setSummaryUpdatedAt] = useState<string | null>(null);

  // ── 是否从 URL 恢复的论文 ──
  const [isRestored, setIsRestored] = useState(false);

  // ── 保存笔记状态（按模块 key / 消息 index）──
  const [sectionSaveStatus, setSectionSaveStatus] = useState<Record<string, "idle" | "saving" | "saved" | "error">>({});
  const [chatSaveStatus, setChatSaveStatus]       = useState<Record<number, "idle" | "saving" | "saved" | "error">>({});

  // ── 研究笔记上下文（用于增强对话质量）──
  const [notesContext, setNotesContext] = useState<string>("");

  useEffect(() => {
    fetch("/api/notes")
      .then(r => r.json())
      .then(d => {
        const notes = d.notes ?? [];
        if (!notes.length) return;
        // 取最近 3 条笔记，提炼成简短背景
        const ctx = notes.slice(0, 3).map((n: { concept: string; related_concepts?: string; user_memo?: string }) =>
          `概念：${n.concept}｜关联领域：${(n.related_concepts ?? "").replace(/[#*`]/g, "").slice(0, 100)}｜用户想法：${n.user_memo ?? "无"}`
        ).join("\n");
        setNotesContext(ctx);
      })
      .catch(() => {/* 静默失败 */});
  }, []);

  // ── 视图切换：summary（默认）| translate（对照翻译）──
  const [currentView, setCurrentView] = useState<"summary" | "translate">("summary");

  // ── PPT 生成状态 ──
  const [pptStatus, setPptStatus] = useState<"idle" | "selecting" | "loading" | "done" | "error">("idle");
  const [pptScene, setPptScene] = useState<"defense" | "meeting" | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [pptContent, setPptContent] = useState<any>(null);
  const [pptError, setPptError] = useState("");
  const [pptDownloading, setPptDownloading] = useState(false);

  // ── 引用格式状态 ──
  const [citeStatus, setCiteStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [bibtex, setBibtex] = useState("");
  const [gbt7714, setGbt7714] = useState("");
  const [copiedBibtex, setCopiedBibtex] = useState(false);
  const [copiedGbt, setCopiedGbt] = useState(false);

  // 自动滚动到对话底部
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 总结文字更新时存 localStorage（包含流式中间状态，切换回来可恢复）
  useEffect(() => {
    if (!paperId || !summaryText) return;
    try {
      localStorage.setItem(`iyanhub_summary_${paperId}`, summaryText);
    } catch { /* 静默失败 */ }
  }, [summaryText, paperId]);

  // 对话结束后把消息存到 localStorage（流式中不存，避免频繁写入）
  useEffect(() => {
    if (!paperId || chatLoading || messages.length === 0) return;
    try {
      localStorage.setItem(`iyanhub_chat_${paperId}`, JSON.stringify(messages));
    } catch { /* 静默失败 */ }
  }, [messages, paperId, chatLoading]);

  // 总结完成后自动触发引用生成（从 DB 加载的已有总结不重复生成）
  useEffect(() => {
    if (summaryStatus === "done" && citeStatus === "idle" && !summaryFromDB) {
      generateCitation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaryStatus]);

  // URL 参数 ?paper=<id> 时自动从数据库加载已有论文
  useEffect(() => {
    const id = searchParams.get("paper");
    if (!id) return;
    setPaperId(id);
    setIsRestored(true);
    async function load() {
      try {
        const res = await fetch(`/api/my-papers/${id}`);
        if (!res.ok) return;
        const { paper } = await res.json();
        if (!paper) return;
        setFileName(paper.title);
        setExtractedText(paper.content || "");
        setExtractStatus("done");

        // 加载已保存的总结（有则直接显示，不需要重新生成）
        const summaryRes  = await fetch(`/api/paper-summaries?paperId=${id}`);
        const summaryData = await summaryRes.json();
        if (summaryData.summary?.summary_content) {
          setSummaryFromDB(true);
          setSummaryUpdatedAt(summaryData.summary.updated_at ?? summaryData.summary.created_at);
          setSummaryText(summaryData.summary.summary_content);
          setSummaryStatus("done");
        } else {
          // DB 无总结（可能切换时还在生成中）→ 从 localStorage 恢复
          try {
            const localSummary = localStorage.getItem(`iyanhub_summary_${id}`);
            if (localSummary) {
              setSummaryText(localSummary);
              setSummaryStatus("done");
            }
          } catch { /* 静默失败 */ }
        }

        // 恢复对话记录
        try {
          const saved = localStorage.getItem(`iyanhub_chat_${id}`);
          if (saved) setMessages(JSON.parse(saved));
        } catch { /* 静默失败 */ }
      } catch { /* 静默失败 */ }
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 从「我的论文」跳转过来时，按 paper_id 加载论文 + 总结 ──────────
  async function loadPaperById(id: string) {
    // 先清空当前状态
    setExtractStatus("idle");
    setExtractedText("");
    setFileName("");
    setSummaryStatus("idle");
    setSummaryText("");
    setSummaryError("");
    setMessages([]);
    setCiteStatus("idle");
    setBibtex("");
    setGbt7714("");
    setCurrentView("summary");
    setPptStatus("idle");
    setPptScene(null);
    setPptContent(null);
    setPaperId(null);
    setSectionSaveStatus({});
    setChatSaveStatus({});
    setSummaryFromDB(false);
    setSummaryUpdatedAt(null);
    setIsRestored(false);
    if (fileInputRef.current) fileInputRef.current.value = "";

    try {
      const res = await fetch(`/api/my-papers/${id}`);
      if (!res.ok) return;
      const { paper } = await res.json();
      if (!paper) return;

      setPaperId(id);
      setFileName(paper.title);
      setExtractedText(paper.content || "");
      setExtractStatus("done");
      setIsRestored(true);

      // 加载已有总结
      const summaryRes  = await fetch(`/api/paper-summaries?paperId=${id}`);
      const summaryData = await summaryRes.json();
      if (summaryData.summary?.summary_content) {
        setSummaryFromDB(true);
        setSummaryUpdatedAt(summaryData.summary.updated_at ?? summaryData.summary.created_at);
        setSummaryText(summaryData.summary.summary_content);
        setSummaryStatus("done");
      } else {
        // 尝试从 localStorage 恢复生成中的总结
        try {
          const local = localStorage.getItem(`iyanhub_summary_${id}`);
          if (local) { setSummaryText(local); setSummaryStatus("done"); }
        } catch { /* 静默 */ }
      }

      // 恢复对话记录
      try {
        const saved = localStorage.getItem(`iyanhub_chat_${id}`);
        if (saved) setMessages(JSON.parse(saved));
      } catch { /* 静默 */ }
    } catch { /* 静默 */ }
  }

  // 监听来自「我的论文」的跳转事件
  useEffect(() => {
    function onLoadPaper(e: Event) {
      const id = (e as CustomEvent<{ id: string | null }>).detail?.id;
      if (id) loadPaperById(id);
      // id 为 null 时：只是切 tab，不加载（相当于新建分析）
    }
    window.addEventListener("spa-load-paper", onLoadPaper);
    return () => window.removeEventListener("spa-load-paper", onLoadPaper);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 提取完成后保存到数据库，并记录 paperId 供笔记来源追踪 ──
  async function savePaperToDB(text: string, file: File) {
    try {
      const res  = await fetch("/api/my-papers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title:    file.name.replace(/\.pdf$/i, ""),
          content:  text,
          fileSize: file.size,
        }),
      });
      const data = await res.json();
      if (data.id) {
        setPaperId(data.id);
      }
    } catch { /* 静默失败 */ }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PDF 上传与提取（分阶段进度）
  // ─────────────────────────────────────────────────────────────────────────────
  async function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setExtractStatus("error");
      setExtractError("请上传 PDF 格式的文件");
      return;
    }

    setFileName(file.name);
    setExtractStatus("loading");
    setUploadStage("uploading");
    setExtractError("");
    setSummaryStatus("idle");
    setSummaryText("");
    setMessages([]);
    setPaperId(null);
    setSectionSaveStatus({});
    setChatSaveStatus({});

    // 1.5 秒后切换到"正在提取文字"阶段（如果请求还没完成）
    const stageTimer = setTimeout(() => setUploadStage("extracting"), 1500);

    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/extract", { method: "POST", body: formData });
      clearTimeout(stageTimer);

      // 先尝试解析 JSON；Vercel 超大文件会返回纯文本 413，需单独处理
      let data: { text?: string; error?: string };
      try {
        data = await res.json();
      } catch {
        if (res.status === 413) {
          throw new Error("PDF 文件太大（最大 50MB），请压缩后重试");
        }
        throw new Error(`服务器错误（HTTP ${res.status}），请刷新页面后重试`);
      }

      if (!res.ok) throw new Error(data.error || "解析失败");
      setExtractedText(data.text ?? "");
      setExtractStatus("done");
      savePaperToDB(data.text ?? "", file);
    } catch (err) {
      clearTimeout(stageTimer);
      setExtractStatus("error");
      setExtractError(err instanceof Error ? err.message : "上传失败，请重试");
    }
  }

  function handleReset() {
    if (paperId) {
      try {
        localStorage.removeItem(`iyanhub_chat_${paperId}`);
        localStorage.removeItem(`iyanhub_summary_${paperId}`);
      } catch { /* 静默失败 */ }
    }
    setExtractStatus("idle");
    setExtractedText("");
    setExtractError("");
    setFileName("");
    setSummaryStatus("idle");
    setSummaryText("");
    setSummaryError("");
    setMessages([]);
    setCiteStatus("idle");
    setBibtex("");
    setGbt7714("");
    setCopiedBibtex(false);
    setCopiedGbt(false);
    setCurrentView("summary");
    setPptStatus("idle");
    setPptScene(null);
    setPptContent(null);
    setPptError("");
    setPaperId(null);
    setSectionSaveStatus({});
    setChatSaveStatus({});
    setSummaryFromDB(false);
    setSummaryUpdatedAt(null);
    setIsRestored(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // ─── 保存总结模块到笔记 ──────────────────────────────────────────────────────
  async function handleSaveSection(sectionKey: string, content: string) {
    if (sectionSaveStatus[sectionKey] === "saving") return;
    setSectionSaveStatus(prev => ({ ...prev, [sectionKey]: "saving" }));
    try {
      const paperTitle = fileName.replace(/\.pdf$/i, "");
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          concept:        sectionKey,
          origin_summary: content,
          source_type:    "summary",
          source_id:      paperId ?? null,
          source_title:   paperTitle,
        }),
      });
      if (!res.ok) throw new Error();
      setSectionSaveStatus(prev => ({ ...prev, [sectionKey]: "saved" }));
      toast.success("已保存到研究笔记");
    } catch {
      setSectionSaveStatus(prev => ({ ...prev, [sectionKey]: "error" }));
      toast.error("保存失败，请重试");
    }
  }

  // ─── 保存 AI 对话回复到笔记 ─────────────────────────────────────────────────
  async function handleSaveChatMsg(index: number, content: string) {
    if (chatSaveStatus[index] === "saving" || chatSaveStatus[index] === "saved") return;
    setChatSaveStatus(prev => ({ ...prev, [index]: "saving" }));
    try {
      const paperTitle = fileName.replace(/\.pdf$/i, "");
      const snippet    = content.slice(0, 50).trim() + (content.length > 50 ? "…" : "");
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          concept:        snippet || "对话回复",
          origin_summary: content,
          source_type:    "chat",
          source_id:      paperId ?? null,
          source_title:   paperTitle,
        }),
      });
      if (!res.ok) throw new Error();
      setChatSaveStatus(prev => ({ ...prev, [index]: "saved" }));
      toast.success("已保存到研究笔记");
    } catch {
      setChatSaveStatus(prev => ({ ...prev, [index]: "error" }));
      toast.error("保存失败，请重试");
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 生成 AI 总结（流式）
  // ─────────────────────────────────────────────────────────────────────────────
  async function handleSummarize() {
    const myId = ++summaryStreamId.current;
    setSummaryStatus("loading");
    setSummaryError("");
    setSummaryText("");
    setSummaryFromDB(false);
    setSummaryUpdatedAt(null);

    try {
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: extractedText }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "总结失败");
      }

      // 逐块读取并累积文字
      let fullText = "";
      for await (const chunk of streamAnthropicSSE(res)) {
        if (summaryStreamId.current !== myId) return; // 用户已重新生成，丢弃旧流
        fullText += chunk;
        setSummaryText(fullText);
      }

      if (summaryStreamId.current !== myId) return;
      setSummaryStatus("done");
      // 自动保存总结到数据库（静默，不影响用户体验）
      if (paperId && fullText) {
        fetch("/api/paper-summaries", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ paperId, summaryContent: fullText }),
        }).catch(() => { /* 静默失败 */ });
      }
    } catch (err) {
      if (summaryStreamId.current !== myId) return;
      setSummaryStatus("error");
      setSummaryError(err instanceof Error ? err.message : "生成失败，请重试");
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 生成 PPT 内容（JSON 结构）
  // ─────────────────────────────────────────────────────────────────────────────
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
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "生成失败");
      setPptContent(data.pptContent);
      setPptStatus("done");
    } catch (err) {
      setPptError(err instanceof Error ? err.message : "生成失败，请重试");
      setPptStatus("error");
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 下载 PPTX 文件（把已生成的 JSON 结构渲染成二进制，不消耗 AI 配额）
  // ─────────────────────────────────────────────────────────────────────────────
  async function handlePptDownload() {
    if (!pptContent || pptDownloading) return;
    setPptDownloading(true);
    try {
      const res = await fetch("/api/ppt/generate-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pptContent }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || "下载失败");
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
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

  // ─────────────────────────────────────────────────────────────────────────────
  // 生成引用格式（BibTeX + GB/T 7714）
  // ─────────────────────────────────────────────────────────────────────────────
  async function generateCitation() {
    setCiteStatus("loading");
    try {
      const res = await fetch("/api/cite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: extractedText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "引用生成失败");
      setBibtex(data.bibtex);
      setGbt7714(data.gbt7714);
      setCiteStatus("done");
    } catch {
      setCiteStatus("error");
    }
  }

  async function copyToClipboard(text: string, type: "bibtex" | "gbt") {
    try {
      await navigator.clipboard.writeText(text);
      if (type === "bibtex") {
        setCopiedBibtex(true);
        setTimeout(() => setCopiedBibtex(false), 2000);
      } else {
        setCopiedGbt(true);
        setTimeout(() => setCopiedGbt(false), 2000);
      }
    } catch { /* 忽略 */ }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 发送对话消息（流式）
  // ─────────────────────────────────────────────────────────────────────────────
  async function handleSendMessage() {
    const text = inputText.trim();
    if (!text || chatLoading) return;

    const myId = ++chatStreamId.current;
    const userMessages: Message[] = [...messages, { role: "user", content: text }];

    // 立刻显示用户消息 + 空白占位（用于流入 AI 回复）
    setMessages([...userMessages, { role: "assistant", content: "" }]);
    setInputText("");
    setChatLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paperContent: extractedText,
          messages: userMessages,
          notesContext: notesContext || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "回复失败");
      }

      let reply = "";
      for await (const chunk of streamAnthropicSSE(res)) {
        if (chatStreamId.current !== myId) return;
        reply += chunk;
        setMessages([...userMessages, { role: "assistant", content: reply }]);
      }
    } catch (err) {
      if (chatStreamId.current !== myId) return;
      setMessages([
        ...userMessages,
        {
          role: "assistant",
          content: `❌ ${err instanceof Error ? err.message : "请求失败，请重试"}`,
        },
      ]);
    } finally {
      if (chatStreamId.current === myId) setChatLoading(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 渲染
  // ─────────────────────────────────────────────────────────────────────────────

  // 总结是否正在流入（有文字但还没 done）
  const isSummaryStreaming = summaryStatus === "loading" && summaryText.length > 0;

  // 全文翻译视图：全屏替换，不显示普通布局
  if (currentView === "translate" && extractedText) {
    return (
      <TranslationView
        extractedText={extractedText}
        onBack={() => setCurrentView("summary")}
      />
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      <Header title="上传论文" />

      <main className="flex-1 flex flex-col items-center px-4 sm:px-6 py-6 sm:py-12 pb-24 sm:pb-12">
        <div className="w-full max-w-3xl space-y-4 sm:space-y-6">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-800 mb-1">上传 PDF 论文</h1>
            <p className="text-sm sm:text-base text-gray-500">上传后 AI 将自动生成总结，并可与论文对话</p>
          </div>

          {/* ===== 上传区域 ===== */}
          {(extractStatus === "idle" || extractStatus === "error") && (
            <div
              className="bg-white rounded-2xl border-2 border-dashed border-gray-300 hover:border-blue-400 transition-colors p-8 sm:p-12 text-center cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
              onDragOver={(e) => e.preventDefault()}
            >
              <div className="text-5xl mb-3 sm:mb-4">📄</div>
              <p className="text-base sm:text-lg font-medium text-gray-700 mb-2">点击选择文件，或拖拽 PDF 到这里</p>
              <p className="text-sm text-gray-400">支持 PDF 格式，最大 50MB</p>
              {extractStatus === "error" && (
                <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
                  ❌ {extractError}
                </div>
              )}
              <input ref={fileInputRef} type="file" accept=".pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
            </div>
          )}

          {/* ===== PDF 上传中（分阶段进度）===== */}
          {extractStatus === "loading" && (
            <div className="bg-white rounded-2xl p-8 sm:p-12 text-center shadow-sm">
              <div className="text-5xl mb-5">
                {uploadStage === "uploading" ? "📤" : "📄"}
              </div>

              {/* 进度步骤指示器 */}
              <div className="flex items-center justify-center gap-2 mb-4">
                {/* 步骤1 */}
                <div className={`flex items-center gap-1.5 text-sm font-medium ${
                  uploadStage === "uploading" ? "text-blue-600" : "text-green-500"
                }`}>
                  {uploadStage === "uploading" ? <DotLoader /> : <span>✓</span>}
                  <span>正在上传</span>
                </div>
                <span className="text-gray-300">→</span>
                {/* 步骤2 */}
                <div className={`flex items-center gap-1.5 text-sm font-medium ${
                  uploadStage === "extracting" ? "text-blue-600" : "text-gray-300"
                }`}>
                  {uploadStage === "extracting" && <DotLoader />}
                  <span>提取文字</span>
                </div>
              </div>

              <p className="text-sm text-gray-400 truncate px-4">{fileName}</p>
            </div>
          )}

          {/* ===== PDF 解析完成 ===== */}
          {extractStatus === "done" && (
            <>
              {/* 文件信息栏 */}
              <div className="bg-white rounded-2xl p-4 sm:p-5 shadow-sm flex items-start sm:items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-800 truncate">✅ {fileName}</p>
                  <p className="text-sm text-gray-400 mt-0.5">已提取 {extractedText.length.toLocaleString()} 个字符</p>
                </div>
                <Button variant="outline" size="sm" onClick={handleReset} className="shrink-0">重新上传</Button>
              </div>

              {/* 已恢复提示 */}
              {isRestored && (
                <div className="flex items-center justify-between bg-blue-50 border border-blue-100 rounded-xl px-4 py-2.5">
                  <span className="text-sm text-blue-700">✨ 已恢复上次的内容</span>
                  <button
                    onClick={handleReset}
                    className="text-xs text-blue-400 hover:text-blue-600 transition-colors ml-4 shrink-0"
                  >
                    清空重新开始
                  </button>
                </div>
              )}

              {/* ===== AI 总结区域 ===== */}

              {/* 等待点击 */}
              {summaryStatus === "idle" && (
                <div className="bg-white rounded-2xl p-6 sm:p-8 text-center shadow-sm border border-blue-100">
                  <div className="text-4xl mb-3">✨</div>
                  <h2 className="text-base sm:text-lg font-semibold text-gray-800 mb-2">让 AI 为你总结这篇论文</h2>
                  <p className="text-sm text-gray-500 mb-5">生成研究问题、方法、结论、创新点四个部分</p>
                  <Button size="lg" className="w-full sm:w-auto" onClick={handleSummarize}>生成 AI 总结</Button>
                </div>
              )}

              {/* 等待第一个 token */}
              {summaryStatus === "loading" && !summaryText && (
                <div className="bg-white rounded-2xl p-8 sm:p-10 text-center shadow-sm">
                  <div className="flex justify-center mb-5">
                    <DotLoader />
                  </div>
                  <p className="text-base sm:text-lg font-medium text-gray-700">AI 正在读取论文...</p>
                  <p className="text-sm text-gray-400 mt-2">通常需要几秒钟</p>
                </div>
              )}

              {/* 流式文字进入中 */}
              {isSummaryStreaming && (
                <div className="space-y-3 sm:space-y-4">
                  <div className="flex items-center gap-2">
                    <DotLoader />
                    <h2 className="text-lg sm:text-xl font-bold text-gray-700">AI 正在生成总结...</h2>
                  </div>
                  <div className="bg-white rounded-2xl p-4 sm:p-6 shadow-sm border border-blue-50">
                    <MarkdownContent content={summaryText} className="text-sm" />
                    {/* 光标闪烁效果 */}
                    <span className="inline-block w-0.5 h-4 bg-blue-400 ml-0.5 align-middle animate-pulse" />
                  </div>
                </div>
              )}

              {/* 生成失败 */}
              {summaryStatus === "error" && (
                <div className="bg-white rounded-2xl p-5 sm:p-6 shadow-sm">
                  <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm mb-4">❌ {summaryError}</div>
                  <Button className="w-full sm:w-auto" onClick={handleSummarize}>重试</Button>
                </div>
              )}

              {/* 生成完毕，拆分展示 */}
              {summaryStatus === "done" && (
                <div className="space-y-3 sm:space-y-4">
                  <div>
                    <h2 className="text-lg sm:text-xl font-bold text-gray-800">📋 AI 论文总结</h2>
                    {summaryFromDB && summaryUpdatedAt && (
                      <p className="text-xs text-gray-400 mt-0.5">
                        上次生成于 {new Date(summaryUpdatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </p>
                    )}
                  </div>
                  {parseSummary(summaryText).map(({ key, icon, content }) => {
                    const saveStatus = sectionSaveStatus[key] ?? "idle";
                    return (
                      <div key={key} className="bg-white rounded-2xl p-4 sm:p-6 shadow-sm border border-gray-100">
                        <div className="flex items-center justify-between mb-2 sm:mb-3">
                          <h3 className="font-semibold text-gray-800">{icon} {key}</h3>
                          <button
                            onClick={() => handleSaveSection(key, content)}
                            disabled={saveStatus === "saving" || saveStatus === "saved"}
                            className={`text-xs transition-colors flex items-center gap-1 shrink-0 ${
                              saveStatus === "saved" ? "text-green-500 cursor-default" :
                              saveStatus === "error" ? "text-red-400 hover:text-red-500" :
                              "text-gray-400 hover:text-blue-500"
                            }`}
                          >
                            {saveStatus === "saving" ? "保存中…" :
                             saveStatus === "saved"  ? "✓ 已保存" :
                             saveStatus === "error"  ? "❌ 重试" :
                             "💾 保存到笔记"}
                          </button>
                        </div>
                        <MarkdownContent content={content} className="text-sm" />
                      </div>
                    );
                  })}
                  <div className="flex gap-2 flex-wrap">
                    <Button variant="outline" className="flex-1" onClick={handleSummarize}>重新生成总结</Button>
                  </div>
                </div>
              )}

              {/* ===== PPT 场景选择 + 结果 ===== */}
              {summaryStatus === "done" && pptStatus !== "idle" && (
                <div className="bg-white rounded-2xl shadow-sm border border-indigo-100 overflow-hidden">
                  <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-indigo-50 bg-indigo-50">
                    <h2 className="font-semibold text-indigo-800">📊 生成 PPT 幻灯片</h2>
                    <p className="text-xs sm:text-sm text-indigo-500 mt-0.5">AI 根据论文内容自动规划幻灯片结构（每月限 3 次）</p>
                  </div>

                  <div className="p-4 sm:p-6 space-y-4">
                    {/* 场景选择 */}
                    {pptStatus === "selecting" && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <button
                          onClick={() => handlePptGenerate("defense")}
                          className="group text-left p-4 rounded-xl border-2 border-blue-100 hover:border-blue-400 hover:bg-blue-50 transition-all"
                        >
                          <div className="text-2xl mb-2">🎓</div>
                          <div className="font-semibold text-gray-800 text-sm mb-1">毕业 / 学位答辩</div>
                          <div className="text-xs text-gray-500 leading-relaxed">正式学术风格，深蓝色调<br/>AI 自动决定页数（通常 15-20 页）</div>
                          <div className="mt-2 text-xs text-blue-600 font-medium opacity-0 group-hover:opacity-100 transition-opacity">点击选择 →</div>
                        </button>
                        <button
                          onClick={() => handlePptGenerate("meeting")}
                          className="group text-left p-4 rounded-xl border-2 border-green-100 hover:border-green-400 hover:bg-green-50 transition-all"
                        >
                          <div className="text-2xl mb-2">📊</div>
                          <div className="font-semibold text-gray-800 text-sm mb-1">组会 / 进展汇报</div>
                          <div className="text-xs text-gray-500 leading-relaxed">简洁汇报风格，清爽简约<br/>AI 自动决定页数（通常 8-12 页）</div>
                          <div className="mt-2 text-xs text-green-600 font-medium opacity-0 group-hover:opacity-100 transition-opacity">点击选择 →</div>
                        </button>
                      </div>
                    )}

                    {/* 生成中 */}
                    {pptStatus === "loading" && (
                      <div className="text-center py-6">
                        <div className="flex justify-center mb-3"><DotLoader /></div>
                        <p className="text-sm text-gray-600">AI 正在规划幻灯片结构…</p>
                        <p className="text-xs text-gray-400 mt-1">通常需要 10-20 秒</p>
                      </div>
                    )}

                    {/* 生成失败 */}
                    {pptStatus === "error" && (
                      <div className="space-y-3">
                        <div className="p-3 bg-red-50 border border-red-100 rounded-lg text-red-500 text-sm">❌ {pptError}</div>
                        <Button size="sm" variant="outline" onClick={() => setPptStatus("selecting")}>重新选择场景</Button>
                      </div>
                    )}

                    {/* 生成完成：可视化幻灯片预览 + 下载 */}
                    {pptStatus === "done" && pptContent && (
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-semibold text-gray-700">
                            ✅ {pptScene === "defense" ? "🎓 答辩" : "📊 组会"} · 共 {pptContent.slides?.length ?? pptContent.total_pages} 页
                          </p>
                          <Button size="sm" variant="outline" onClick={() => setPptStatus("selecting")} className="text-xs">
                            换场景
                          </Button>
                        </div>

                        {/* 幻灯片可视化预览 */}
                        <PptSlidePreview pptContent={pptContent} />

                        {/* 下载按钮 */}
                        <Button
                          onClick={handlePptDownload}
                          disabled={pptDownloading}
                          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white"
                        >
                          {pptDownloading ? "正在生成 PPTX…" : "⬇ 下载 PPTX 文件"}
                        </Button>
                        <p className="text-xs text-center text-gray-400">下载不消耗额外次数</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ===== 引用格式导出 ===== */}
              {citeStatus !== "idle" && (
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                  <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-gray-100 bg-gray-50">
                    <h2 className="font-semibold text-gray-800">📎 引用格式导出</h2>
                    <p className="text-xs sm:text-sm text-gray-400 mt-0.5">一键复制到 Overleaf 或中文论文参考文献列表</p>
                  </div>
                  <div className="p-4 sm:p-6 space-y-5">
                    {citeStatus === "loading" && (
                      <div className="flex items-center gap-2 text-gray-400 text-sm py-1">
                        <DotLoader />
                        <span>正在生成引用格式...</span>
                      </div>
                    )}
                    {citeStatus === "error" && (
                      <div className="text-sm text-red-500 py-1">
                        ❌ 引用生成失败，
                        <button className="underline ml-1" onClick={generateCitation}>点击重试</button>
                      </div>
                    )}
                    {citeStatus === "done" && (
                      <>
                        {/* BibTeX */}
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">BibTeX（Overleaf / LaTeX）</span>
                            <Button size="sm" variant="outline" onClick={() => copyToClipboard(bibtex, "bibtex")} className="text-xs h-7 px-3">
                              {copiedBibtex ? "已复制 ✓" : "复制"}
                            </Button>
                          </div>
                          <pre className="bg-gray-50 rounded-xl p-3 text-xs text-gray-700 overflow-x-auto whitespace-pre-wrap leading-relaxed font-mono border border-gray-100">{bibtex}</pre>
                        </div>
                        {/* GB/T 7714 */}
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">GB/T 7714-2015（国标 · 中文论文）</span>
                            <Button size="sm" variant="outline" onClick={() => copyToClipboard(gbt7714, "gbt")} className="text-xs h-7 px-3">
                              {copiedGbt ? "已复制 ✓" : "复制"}
                            </Button>
                          </div>
                          <p className="bg-gray-50 rounded-xl p-3 text-sm text-gray-700 leading-relaxed border border-gray-100">{gbt7714}</p>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* ===== 论文对话区域（总结完成后显示）===== */}
              {summaryStatus === "done" && (
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                  <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-gray-100 bg-gray-50">
                    <h2 className="font-semibold text-gray-800">💬 与论文对话</h2>
                    <p className="text-xs sm:text-sm text-gray-400 mt-0.5">针对这篇论文的内容提问，AI 将基于原文回答</p>
                    {notesContext && (
                      <div className="mt-2 flex items-start gap-1.5 bg-blue-50 rounded-lg px-3 py-2">
                        <span className="text-blue-400 text-xs mt-0.5 shrink-0">📓</span>
                        <p className="text-xs text-blue-600 leading-relaxed">
                          已加载你的<a href="/my-notes" className="font-medium underline underline-offset-2">研究笔记</a>作为背景——可以这样提问：
                          <span className="text-blue-500 italic">「结合我研究的界面钝化方向，这篇论文有哪些值得关注的内容？」</span>
                        </p>
                      </div>
                    )}
                  </div>

                  {/* 消息列表 */}
                  <div className="p-3 sm:p-4 space-y-3 sm:space-y-4 max-h-64 sm:max-h-96 overflow-y-auto">
                    {messages.length === 0 && (
                      <div className="text-center py-6 sm:py-8 text-gray-400 text-sm">
                        <p className="text-2xl mb-2">💡</p>
                        <p>可以问任何关于这篇论文的问题</p>
                        <p className="mt-1 text-xs">例如："这篇论文用了什么数据集？"</p>
                      </div>
                    )}
                    {messages.map((msg, i) => {
                      const isLastMsg = i === messages.length - 1;
                      const isStreamingThis = isLastMsg && msg.role === "assistant" && chatLoading;
                      const msgSaveStatus = chatSaveStatus[i] ?? "idle";
                      return (
                        <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                          {msg.role === "user" ? (
                            <div className="max-w-[85%] rounded-2xl px-3 sm:px-4 py-2.5 sm:py-3 text-sm leading-relaxed whitespace-pre-wrap bg-blue-600 text-white rounded-br-sm">
                              {msg.content}
                            </div>
                          ) : (
                            <div className="max-w-[85%] flex flex-col items-start gap-1">
                              <div className="rounded-2xl px-3 sm:px-4 py-2.5 sm:py-3 text-sm leading-relaxed bg-gray-100 text-gray-800 rounded-bl-sm w-full">
                                {!msg.content && isStreamingThis
                                  ? <span className="flex gap-1 py-0.5"><span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.3s]" /><span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.15s]" /><span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" /></span>
                                  : isStreamingThis
                                    ? <pre className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap" style={{ fontFamily: "inherit" }}>{msg.content}</pre>
                                    : <MarkdownContent content={msg.content} />
                                }
                                {isStreamingThis && msg.content && (
                                  <span className="inline-block w-0.5 h-3.5 bg-gray-500 ml-0.5 align-middle animate-pulse" />
                                )}
                              </div>
                              {!isStreamingThis && msg.content && (
                                <button
                                  onClick={() => handleSaveChatMsg(i, msg.content)}
                                  disabled={msgSaveStatus === "saving" || msgSaveStatus === "saved"}
                                  className={`text-xs transition-colors flex items-center gap-1 px-1 ${
                                    msgSaveStatus === "saved" ? "text-green-500 cursor-default" :
                                    msgSaveStatus === "error" ? "text-red-400 hover:text-red-500" :
                                    "text-gray-400 hover:text-blue-500"
                                  }`}
                                >
                                  {msgSaveStatus === "saving" ? "保存中…" :
                                   msgSaveStatus === "saved"  ? "✓ 已保存" :
                                   msgSaveStatus === "error"  ? "❌ 重试" :
                                   "💾 保存到笔记"}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <div ref={chatBottomRef} />
                  </div>

                  {/* 输入框 */}
                  <div className="p-3 sm:p-4 border-t border-gray-100 flex gap-2 sm:gap-3">
                    <input
                      type="text"
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } }}
                      placeholder="输入问题，按回车发送..."
                      disabled={chatLoading}
                      className="flex-1 min-w-0 rounded-xl border border-gray-200 px-3 sm:px-4 py-2.5 text-base outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:opacity-50"
                    />
                    <Button onClick={handleSendMessage} disabled={chatLoading || !inputText.trim()} className="shrink-0">
                      发送
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

export default function UploadPage() {
  return (
    <Suspense fallback={null}>
      <UploadPageInner />
    </Suspense>
  );
}
