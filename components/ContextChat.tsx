"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { MarkdownContent } from "@/components/MarkdownContent";
import { toast } from "sonner";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ContextChatProps {
  context: string;
  sectionTitle: string;
  placeholder: string;
  sourceType: "keyword" | "concept";
  sourceTitle: string;
}

export function ContextChat({
  context,
  sectionTitle,
  placeholder,
  sourceType,
  sourceTitle,
}: ContextChatProps) {
  const [messages, setMessages]       = useState<Message[]>([]);
  const [input, setInput]             = useState("");
  const [isStreaming, setIsStreaming]  = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError]             = useState("");
  const [saveStatus, setSaveStatus]   = useState<Record<number, "idle" | "saving" | "saved" | "error">>({});

  const bottomRef   = useRef<HTMLDivElement>(null);

  // 新消息出现时滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  async function handleSend() {
    const text = input.trim();
    if (!text || isStreaming) return;

    const userMsg: Message = { role: "user", content: text };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setIsStreaming(true);
    setStreamingText("");
    setError("");

    try {
      const res = await fetch("/api/context-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context, messages: newMessages }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || "请求失败，请重试");
      }
      if (!res.body) throw new Error("服务器响应为空");

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";
      let fullText  = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === "[DONE]") continue;
          try {
            const evt = JSON.parse(raw);
            if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
              fullText += evt.delta.text ?? "";
              setStreamingText(fullText);
            }
          } catch { /* skip */ }
        }
      }

      setMessages(prev => [...prev, { role: "assistant", content: fullText }]);
      setStreamingText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "请求失败，请重试");
    } finally {
      setIsStreaming(false);
    }
  }

  async function handleSaveMessage(index: number, content: string) {
    if (saveStatus[index] === "saving" || saveStatus[index] === "saved") return;
    setSaveStatus(prev => ({ ...prev, [index]: "saving" }));
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          concept:        sourceTitle,
          origin_summary: content,
          source_type:    sourceType,
          source_id:      null,
          source_title:   sourceTitle,
        }),
      });
      if (!res.ok) throw new Error();
      setSaveStatus(prev => ({ ...prev, [index]: "saved" }));
      toast.success("已保存到研究笔记");
    } catch {
      setSaveStatus(prev => ({ ...prev, [index]: "error" }));
      toast.error("保存失败，请重试");
    }
  }

  if (!context) return null;

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      {/* 标题栏 */}
      <div className="px-4 sm:px-6 py-3 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50">
        <h2 className="font-semibold text-gray-800 text-sm sm:text-base flex items-center gap-2">
          <span>💬</span>
          <span>{sectionTitle}</span>
        </h2>
      </div>

      <div className="p-4 sm:p-6 space-y-4">
        {/* 对话历史 */}
        {messages.length > 0 && (
          <div className="space-y-4">
            {messages.map((msg, i) =>
              msg.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[80%] bg-blue-600 text-white rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm leading-relaxed">
                    {msg.content}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex justify-start">
                  <div className="max-w-[90%] space-y-1.5">
                    <div className="bg-gray-50 border border-gray-100 rounded-2xl rounded-tl-sm px-4 py-3">
                      <MarkdownContent content={msg.content} className="text-sm" />
                    </div>
                    {/* 保存到笔记按钮 */}
                    <div className="flex justify-end pr-1">
                      <button
                        onClick={() => handleSaveMessage(i, msg.content)}
                        disabled={saveStatus[i] === "saving" || saveStatus[i] === "saved"}
                        className={`text-xs transition-colors flex items-center gap-1 ${
                          saveStatus[i] === "saved"  ? "text-green-500 cursor-default" :
                          saveStatus[i] === "error"  ? "text-red-400 hover:text-red-500" :
                          "text-gray-400 hover:text-blue-500"
                        }`}
                      >
                        {saveStatus[i] === "saving" ? "保存中…" :
                         saveStatus[i] === "saved"  ? "✓ 已保存" :
                         saveStatus[i] === "error"  ? "❌ 重试"  :
                         "💾 保存到笔记"}
                      </button>
                    </div>
                  </div>
                </div>
              )
            )}

            {/* 流式输出中的气泡 */}
            {isStreaming && (
              <div className="flex justify-start">
                <div className="max-w-[90%] bg-gray-50 border border-gray-100 rounded-2xl rounded-tl-sm px-4 py-3">
                  {streamingText ? (
                    <pre className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap" style={{ fontFamily: "inherit" }}>{streamingText}</pre>
                  ) : (
                    <span className="inline-flex gap-1 items-center">
                      <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                      <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                      <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" />
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 错误提示 */}
        {error && (
          <div className="p-3 bg-red-50 border border-red-100 rounded-xl text-xs text-red-500">
            ❌ {error}
          </div>
        )}

        <div ref={bottomRef} />

        {/* 输入区域 */}
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={placeholder}
            rows={3}
            disabled={isStreaming}
            className="flex-1 rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 resize-none disabled:opacity-50 disabled:cursor-not-allowed leading-relaxed"
          />
          <Button
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
            className="shrink-0 px-4 py-2.5 h-auto"
          >
            发送
          </Button>
        </div>
        <p className="text-xs text-gray-400">Ctrl/Cmd + Enter 发送</p>
      </div>
    </div>
  );
}
