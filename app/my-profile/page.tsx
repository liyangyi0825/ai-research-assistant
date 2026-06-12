"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Header } from "@/components/Header";

// ─── 类型 ────────────────────────────────────────────────────────────────────

interface Profile {
  research_direction: string;
  research_workflow:  string;
  core_question:      string;
  known_methods:      string;
  ai_preferences:     string[];
  profile_complete:   boolean;
}

type View = "loading" | "choose" | "form" | "interview" | "review";

// ─── 常量 ────────────────────────────────────────────────────────────────────

const QUESTIONS = [
  "你现在读几年级？主要做什么方向的研究？\n随便说说就行，不用很正式。",
  "你最近在研究的具体课题是什么？\n或者说你的毕业论文 / 项目是做什么的？",
  "你平时怎么找论文和资料？\n比如先找综述、还是直接搜关键词、还是导师推荐？大概说说你的习惯。",
  "你现在研究里遇到最头疼的问题是什么？\n比如找不到合适文献、看不懂某个方法、还是别的？",
  "你已经比较熟悉哪些研究方法或技术？\n说几个关键词就行。",
];

const AI_PREFS = [
  "总结论文时重点关注和我课题相关的内容",
  "帮我找和我方法有关联的其他研究",
  "主动提示我可能没想到的角度",
  "帮我记录每次的研究灵感",
  "用简单语言解释专业概念",
];

const EMPTY_FORM: Profile = {
  research_direction: "",
  research_workflow:  "",
  core_question:      "",
  known_methods:      "",
  ai_preferences:     [],
  profile_complete:   false,
};

// ─── 组件 ────────────────────────────────────────────────────────────────────

function Toast({ msg, onClose }: { msg: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3500);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-sm px-5 py-3 rounded-2xl shadow-xl z-50 flex items-center gap-2 animate-in fade-in">
      <span>✅</span><span>{msg}</span>
    </div>
  );
}

// ─── 主页面 ──────────────────────────────────────────────────────────────────

export default function MyProfilePage() {
  const [view,     setView]     = useState<View>("loading");
  const [form,     setForm]     = useState<Profile>(EMPTY_FORM);
  const [saving,   setSaving]   = useState(false);
  const [toast,    setToast]    = useState<string | null>(null);
  const [isEdit,   setIsEdit]   = useState(false); // 编辑已有档案

  // ── 路线 B 状态 ──
  const [step,          setStep]          = useState(0);
  const [answers,       setAnswers]       = useState<string[]>(new Array(5).fill(""));
  const [currentAnswer, setCurrentAnswer] = useState("");
  const [displayedQ,    setDisplayedQ]    = useState("");
  const [isTyping,      setIsTyping]      = useState(false);
  const [summarizing,   setSummarizing]   = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 初始化：读取已有档案
  useEffect(() => {
    fetch("/api/profile")
      .then(r => r.json())
      .then(d => {
        if (d.profile?.profile_complete) {
          setForm({ ...EMPTY_FORM, ...d.profile });
          setIsEdit(true);
          setView("form");
        } else if (d.profile) {
          setForm({ ...EMPTY_FORM, ...d.profile });
          setView("choose");
        } else {
          setView("choose");
        }
      })
      .catch(() => setView("choose"));
  }, []);

  // 打字机效果
  function typeQuestion(text: string) {
    setDisplayedQ("");
    setIsTyping(true);
    if (timerRef.current) clearInterval(timerRef.current);
    let i = 0;
    timerRef.current = setInterval(() => {
      i++;
      setDisplayedQ(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(timerRef.current!);
        setIsTyping(false);
      }
    }, 22);
  }

  // 开始路线 B
  function startInterview() {
    setStep(0);
    setAnswers(new Array(5).fill(""));
    setCurrentAnswer("");
    setView("interview");
    setTimeout(() => typeQuestion(QUESTIONS[0]), 200);
  }

  // 提交当前回答，进入下一题
  function submitAnswer() {
    if (!currentAnswer.trim() || isTyping) return;
    const newAnswers = [...answers];
    newAnswers[step] = currentAnswer;
    setAnswers(newAnswers);
    setCurrentAnswer("");

    if (step < 4) {
      setStep(step + 1);
      setTimeout(() => typeQuestion(QUESTIONS[step + 1]), 300);
    } else {
      // 5 题全部回答完，调 AI 整理
      summarizeProfile(newAnswers);
    }
  }

  async function summarizeProfile(ans: string[]) {
    setSummarizing(true);
    try {
      const res = await fetch("/api/profile/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: ans }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setForm(prev => ({ ...prev, ...data.profile }));
      setView("review");
    } catch {
      setToast("AI 整理失败，请重试");
    } finally {
      setSummarizing(false);
    }
  }

  async function saveProfile(complete = true) {
    setSaving(true);
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, profile_complete: complete }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setForm(prev => ({ ...prev, profile_complete: complete }));
      setIsEdit(true);
      setToast("档案已保存，AI 现在了解你了 ✓");
      if (complete) setTimeout(() => { window.location.href = "/"; }, 2000);
    } catch {
      setToast("保存失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  function togglePref(pref: string) {
    setForm(prev => ({
      ...prev,
      ai_preferences: prev.ai_preferences.includes(pref)
        ? prev.ai_preferences.filter(p => p !== pref)
        : [...prev.ai_preferences, pref],
    }));
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      <Header title="我的档案" />
      {toast && <Toast msg={toast} onClose={() => setToast(null)} />}

      <main className="flex-1 flex flex-col items-center px-4 sm:px-6 py-6 sm:py-10 pb-24 sm:pb-12">
        <div className="w-full max-w-2xl space-y-5">

          {/* ── 加载 ── */}
          {view === "loading" && (
            <div className="bg-white rounded-2xl p-10 text-center text-gray-400 shadow-sm">
              加载中…
            </div>
          )}

          {/* ── 选择路线 ── */}
          {view === "choose" && (
            <div className="space-y-4">
              <div>
                <h1 className="text-xl sm:text-2xl font-bold text-gray-800 mb-1">建立你的科研档案</h1>
                <p className="text-sm text-gray-500">
                  完成后 AI 将按你的研究方向给出更有针对性的回答，而不是通用建议。
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* 选项 B（推荐）*/}
                <button
                  onClick={startInterview}
                  className="group bg-blue-600 hover:bg-blue-700 text-white rounded-2xl p-6 text-left transition-all shadow-md hover:shadow-lg"
                >
                  <div className="text-2xl mb-3">🤖</div>
                  <div className="flex items-center gap-2 mb-1">
                    <h2 className="font-bold text-lg">让 AI 来问我</h2>
                    <span className="text-xs bg-blue-500 px-2 py-0.5 rounded-full">推荐</span>
                  </div>
                  <p className="text-sm text-blue-100 leading-relaxed">
                    适合不知道怎么描述自己研究的同学，AI 通过几个问题帮你自动生成档案
                  </p>
                </button>

                {/* 选项 A */}
                <button
                  onClick={() => setView("form")}
                  className="group bg-white hover:bg-gray-50 border border-gray-200 hover:border-gray-300 text-gray-800 rounded-2xl p-6 text-left transition-all shadow-sm"
                >
                  <div className="text-2xl mb-3">✍️</div>
                  <h2 className="font-bold text-lg mb-1">自己填写</h2>
                  <p className="text-sm text-gray-500 leading-relaxed">
                    适合已经想清楚研究方向的同学，直接填写各项内容
                  </p>
                </button>
              </div>
            </div>
          )}

          {/* ── 路线 B：对话式问答 ── */}
          {view === "interview" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h1 className="text-lg font-bold text-gray-800">🤖 AI 引导建档</h1>
                <button
                  onClick={() => setView("form")}
                  className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                >
                  切换到手动填写 →
                </button>
              </div>

              {/* 进度条 */}
              <div className="flex gap-1.5">
                {QUESTIONS.map((_, i) => (
                  <div
                    key={i}
                    className={`h-1.5 flex-1 rounded-full transition-colors ${
                      i < step ? "bg-blue-500" : i === step ? "bg-blue-300" : "bg-gray-200"
                    }`}
                  />
                ))}
              </div>

              {/* 对话区 */}
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                <div className="p-5 sm:p-6 space-y-4 min-h-[200px]">
                  {/* 已完成的问答 */}
                  {answers.slice(0, step).map((ans, i) => (
                    <div key={i} className="space-y-2">
                      <div className="flex items-start gap-2.5">
                        <span className="w-7 h-7 rounded-full bg-blue-100 text-blue-600 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">AI</span>
                        <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line pt-1">{QUESTIONS[i]}</p>
                      </div>
                      <div className="flex items-start gap-2.5 justify-end">
                        <p className="text-sm text-white bg-blue-600 rounded-2xl rounded-br-sm px-4 py-2 leading-relaxed max-w-[80%]">{ans}</p>
                        <span className="w-7 h-7 rounded-full bg-gray-200 text-gray-600 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">我</span>
                      </div>
                    </div>
                  ))}

                  {/* 当前问题 */}
                  {!summarizing && (
                    <div className="flex items-start gap-2.5">
                      <span className="w-7 h-7 rounded-full bg-blue-100 text-blue-600 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">AI</span>
                      <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line pt-1">
                        {displayedQ}
                        {isTyping && <span className="inline-block w-0.5 h-4 bg-blue-400 ml-0.5 align-middle animate-pulse" />}
                      </p>
                    </div>
                  )}

                  {/* AI 整理中 */}
                  {summarizing && (
                    <div className="flex items-center gap-2.5 text-gray-400 text-sm py-2">
                      <span className="w-7 h-7 rounded-full bg-blue-100 text-blue-600 text-xs font-bold flex items-center justify-center shrink-0">AI</span>
                      <span className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                        <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                        <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" />
                        <span className="ml-1">正在整理你的研究档案…</span>
                      </span>
                    </div>
                  )}
                </div>

                {/* 输入框 */}
                {!summarizing && (
                  <div className="border-t border-gray-100 p-4 flex gap-2">
                    <textarea
                      value={currentAnswer}
                      onChange={e => setCurrentAnswer(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitAnswer(); }
                      }}
                      disabled={isTyping}
                      placeholder={isTyping ? "AI 正在提问…" : "输入你的回答（Enter 发送）"}
                      rows={2}
                      className="flex-1 rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 resize-none disabled:opacity-50"
                    />
                    <Button
                      onClick={submitAnswer}
                      disabled={!currentAnswer.trim() || isTyping}
                      className="shrink-0 self-end"
                    >
                      {step < 4 ? "继续" : "完成"}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── 路线 B：AI 生成结果 review ── */}
          {view === "review" && (
            <div className="space-y-4">
              <div>
                <h1 className="text-lg font-bold text-gray-800 mb-1">📋 AI 帮你整理的研究档案</h1>
                <p className="text-sm text-gray-500">根据你说的整理如下，可以直接修改任意内容，确认后保存。</p>
              </div>
              {/* 复用表单视图 */}
              <ProfileForm
                form={form}
                setForm={setForm}
                onSave={() => saveProfile(true)}
                saving={saving}
                onBack={() => setView("interview")}
                backLabel="← 重新问答"
              />
            </div>
          )}

          {/* ── 路线 A / 编辑已有档案 ── */}
          {view === "form" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-lg sm:text-xl font-bold text-gray-800 mb-0.5">
                    {isEdit ? "我的科研档案" : "填写科研档案"}
                  </h1>
                  <p className="text-sm text-gray-500">
                    {isEdit ? "随时修改，保存后立即生效" : "填写完成后 AI 将按你的方式帮你做研究"}
                  </p>
                </div>
                {!isEdit && (
                  <button
                    onClick={startInterview}
                    className="text-xs text-blue-500 hover:underline"
                  >
                    改用 AI 问答 →
                  </button>
                )}
              </div>
              <ProfileForm
                form={form}
                setForm={setForm}
                onSave={() => saveProfile(true)}
                saving={saving}
              />
            </div>
          )}

        </div>
      </main>
    </div>
  );
}

// ─── 表单组件（路线 A 和 B Review 共用）────────────────────────────────────────

function ProfileForm({
  form, setForm, onSave, saving, onBack, backLabel,
}: {
  form: Profile;
  setForm: (f: Profile) => void;
  onSave: () => void;
  saving: boolean;
  onBack?: () => void;
  backLabel?: string;
}) {
  function update(key: keyof Profile, value: string) {
    setForm({ ...form, [key]: value.slice(0, 500) });
  }

  function togglePref(pref: string) {
    const prefs = form.ai_preferences ?? [];
    setForm({
      ...form,
      ai_preferences: prefs.includes(pref)
        ? prefs.filter(p => p !== pref)
        : [...prefs, pref],
    });
  }

  const AI_PREFS = [
    "总结论文时重点关注和我课题相关的内容",
    "帮我找和我方法有关联的其他研究",
    "主动提示我可能没想到的角度",
    "帮我记录每次的研究灵感",
    "用简单语言解释专业概念",
  ];

  return (
    <div className="space-y-4">
      {/* 1. 研究方向 */}
      <FieldCard icon="📌" label="研究方向">
        <input
          value={form.research_direction ?? ""}
          onChange={e => update("research_direction", e.target.value)}
          placeholder="例：钙钛矿太阳能电池的界面工程"
          className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
        />
      </FieldCard>

      {/* 2. 科研流程 */}
      <FieldCard icon="🔄" label="我的科研流程">
        <textarea
          value={form.research_workflow ?? ""}
          onChange={e => update("research_workflow", e.target.value)}
          placeholder={"描述你做研究的习惯步骤，不限格式。\n例：先找综述 → 找近 3 年高引论文 → 和实验数据对比 → 找创新点"}
          rows={3}
          className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 resize-none leading-relaxed"
        />
      </FieldCard>

      {/* 3. 核心问题 */}
      <FieldCard icon="❓" label="我目前最想解决的问题">
        <input
          value={form.core_question ?? ""}
          onChange={e => update("core_question", e.target.value)}
          placeholder="例：如何提高钙钛矿电池在湿度环境下的稳定性"
          className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
        />
      </FieldCard>

      {/* 4. 已掌握方法 */}
      <FieldCard icon="🔧" label="我已熟悉的方法">
        <input
          value={form.known_methods ?? ""}
          onChange={e => update("known_methods", e.target.value)}
          placeholder="例：界面钝化、溶剂工程、添加剂策略"
          className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
        />
      </FieldCard>

      {/* 5. AI 偏好 */}
      <FieldCard icon="🤖" label="我希望 AI 怎么帮我（可多选）">
        <div className="space-y-2">
          {AI_PREFS.map(pref => {
            const checked = (form.ai_preferences ?? []).includes(pref);
            return (
              <label key={pref} className="flex items-center gap-3 cursor-pointer group">
                <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                  checked ? "bg-blue-600 border-blue-600" : "border-gray-300 group-hover:border-blue-400"
                }`}>
                  {checked && <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7"/></svg>}
                </div>
                <span className="text-sm text-gray-700">{pref}</span>
              </label>
            );
          })}
        </div>
      </FieldCard>

      {/* 按钮 */}
      <div className="flex gap-3">
        {onBack && (
          <Button variant="outline" onClick={onBack} className="flex-1">
            {backLabel ?? "← 返回"}
          </Button>
        )}
        <Button
          onClick={onSave}
          disabled={saving}
          className="flex-1"
          size="lg"
        >
          {saving ? "保存中…" : "保存档案"}
        </Button>
      </div>
    </div>
  );
}

function FieldCard({ icon, label, children }: { icon: string; label: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl p-4 sm:p-5 shadow-sm border border-gray-100">
      <label className="flex items-center gap-2 text-sm font-semibold text-gray-700 mb-3">
        <span>{icon}</span><span>{label}</span>
      </label>
      {children}
    </div>
  );
}
