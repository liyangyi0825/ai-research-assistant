"use client";
import { useRef } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".pdf")) return;
    // 把文件存到 sessionStorage key，让 /upload 页面读取
    // 当前框架阶段：直接跳转 /upload，具体流程在那里处理
    router.push("/upload");
  }

  return (
    <div
      className="flex flex-col items-center justify-center min-h-full px-4 py-12"
      style={{ background: "#F8FAFC" }}
    >
      {/* 标题区 */}
      <div className="text-center mb-10">
        <h1 className="text-3xl sm:text-4xl font-bold mb-3" style={{ color: "#0F172A" }}>
          上传论文，开始 AI 分析
        </h1>
        <p className="text-base sm:text-lg" style={{ color: "#64748B" }}>
          自动生成结构化总结，与论文对话，生成 PPT，一键翻译
        </p>
      </div>

      {/* 上传区域 */}
      <div
        className="w-full max-w-xl cursor-pointer rounded-2xl border-2 border-dashed transition-all group"
        style={{ borderColor: "#CBD5E1", background: "#FFFFFF" }}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files?.[0];
          if (file) handleFile(file);
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLDivElement).style.borderColor = "#3B82F6";
          (e.currentTarget as HTMLDivElement).style.background = "#EFF6FF";
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLDivElement).style.borderColor = "#CBD5E1";
          (e.currentTarget as HTMLDivElement).style.background = "#FFFFFF";
        }}
      >
        <div className="flex flex-col items-center justify-center py-16 px-8 gap-4">
          {/* 图标 */}
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center text-3xl shadow-sm"
            style={{ background: "#EFF6FF" }}
          >
            📄
          </div>

          <div className="text-center">
            <p className="font-semibold text-base mb-1" style={{ color: "#1E293B" }}>
              点击选择文件，或拖拽 PDF 到这里
            </p>
            <p className="text-sm" style={{ color: "#94A3B8" }}>
              支持 PDF 格式，最大 50MB
            </p>
          </div>

          <button
            onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}
            className="mt-2 px-6 py-2.5 rounded-lg text-sm font-medium text-white transition-all"
            style={{ background: "#3B82F6" }}
            onMouseEnter={e => (e.currentTarget.style.background = "#2563EB")}
            onMouseLeave={e => (e.currentTarget.style.background = "#3B82F6")}
          >
            选择文件上传
          </button>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept=".pdf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
      </div>

      {/* 功能亮点（三列小卡片） */}
      <div className="w-full max-w-xl mt-10 grid grid-cols-3 gap-3">
        {[
          { icon: "✨", text: "AI 论文总结" },
          { icon: "💬", text: "与论文对话" },
          { icon: "🎯", text: "一键生成 PPT" },
        ].map((item) => (
          <div
            key={item.text}
            className="flex flex-col items-center gap-1.5 py-4 rounded-xl text-center"
            style={{ background: "#FFFFFF", border: "1px solid #E2E8F0" }}
          >
            <span className="text-xl">{item.icon}</span>
            <span className="text-xs font-medium" style={{ color: "#475569" }}>
              {item.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
