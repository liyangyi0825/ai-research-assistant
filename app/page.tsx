import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Header } from "@/components/Header";

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      <Header />

      {/* 主内容区 */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 sm:px-6 py-10 sm:py-20 pb-24 sm:pb-20 text-center">
        <div className="max-w-2xl mx-auto w-full">
          {/* 标题 */}
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3 sm:mb-4 leading-tight">
            读论文，从此不再费力
          </h1>
          <p className="text-base sm:text-xl text-gray-600 mb-6 sm:mb-8 leading-relaxed">
            上传 PDF 论文，AI 自动生成结构化总结，还能跟论文"对话"——
            研究问题、方法、结论，一目了然。
          </p>

          {/* 功能卡片 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 mb-7 sm:mb-10">
            <div className="bg-white rounded-xl p-4 sm:p-5 shadow-sm border border-gray-100 flex items-center gap-3 text-left">
              <div className="text-3xl shrink-0">📄</div>
              <div>
                <h3 className="font-semibold text-gray-800 mb-0.5">上传论文 · AI 总结</h3>
                <p className="text-sm text-gray-500">上传 PDF，自动生成研究问题、方法、结论、创新点</p>
              </div>
            </div>
            <div className="bg-white rounded-xl p-4 sm:p-5 shadow-sm border border-gray-100 flex items-center gap-3 text-left">
              <div className="text-3xl shrink-0">💬</div>
              <div>
                <h3 className="font-semibold text-gray-800 mb-0.5">与论文对话</h3>
                <p className="text-sm text-gray-500">基于论文内容提问，AI 精准回答，还能导出引用格式</p>
              </div>
            </div>
            <div className="bg-white rounded-xl p-4 sm:p-5 shadow-sm border border-blue-100 bg-blue-50/50 flex items-center gap-3 text-left">
              <div className="text-3xl shrink-0">🔍</div>
              <div>
                <h3 className="font-semibold text-gray-800 mb-0.5">检索词矩阵生成</h3>
                <p className="text-sm text-gray-500">输入课题，AI 生成 8-10 个精准英文检索词，直达 Google Scholar</p>
              </div>
            </div>
            <div className="bg-white rounded-xl p-4 sm:p-5 shadow-sm border border-gray-100 flex items-center gap-3 text-left opacity-50">
              <div className="text-3xl shrink-0">📚</div>
              <div>
                <h3 className="font-semibold text-gray-800 mb-0.5">更多功能</h3>
                <p className="text-sm text-gray-500">文献批量对比、参考文献提取……持续开发中</p>
              </div>
            </div>
          </div>

          {/* 行动按钮 */}
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/upload"
              className={buttonVariants({ size: "lg" }) + " w-full sm:w-auto"}
            >
              上传论文
            </Link>
            <Link
              href="/literature-search"
              className={buttonVariants({ size: "lg", variant: "outline" }) + " w-full sm:w-auto"}
            >
              🔍 生成检索词
            </Link>
          </div>

          <p className="mt-6 text-xs text-gray-400">
            目前为开发测试阶段 · MVP 版本
          </p>
        </div>
      </main>

      {/* 底部 */}
      <footer className="text-center py-4 text-xs text-gray-400 border-t border-gray-200 bg-white/50">
        AI 科研助手 · 大学生文献阅读效率工具
      </footer>
    </div>
  );
}
