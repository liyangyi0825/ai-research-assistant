// 按页翻译接口：每次翻译 PDF 的一页
// 只在第一页（isFirst=true）检查并记录用量，整篇 PDF 只消耗一次配额
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { withAiUsage } from "@/lib/billing/ai-usage";
import { translationContinuationPolicy } from "@/lib/billing/ai-continuation";
import { fetchWithProxy } from "@/lib/fetch-proxy";

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const PER_ATTEMPT_TIMEOUT_MS = 90000;

function buildPrompt(text: string, pageNum: number, isChunk = false): string {
  return `本页文字从双栏PDF提取，可能存在左右栏交叉混排。
请先理解全文内容和逻辑，然后按正确阅读顺序（先读完左栏，再读右栏）重新整理后翻译，
确保译文段落顺序与论文原始逻辑一致。

请将以下论文第 ${pageNum} 页的内容翻译成中文。

基本要求：
- 保留段落结构，每个自然段对应输出一段
- 专业术语格式：中文（English原文），例如"界面钝化（interface passivation）"
- 参考文献条目不翻译，直接输出英文原文
- 人名、机构名、期刊名保留英文
- 直接输出译文，不要加任何解释或注释

图表说明文字处理规则：
- "Figure X: ..." → 译为"图X："，并以 Markdown 引用块格式单独输出（行首加 > ）
- "Table X: ..." → 译为"表X："，并以 Markdown 引用块格式单独输出（行首加 > ）
- "Fig. X ..." → 译为"图X "，并以 Markdown 引用块格式单独输出（行首加 > ）
- 图表说明的其余文字正常翻译成中文
- 示例：
    原文：Figure 1: Comparison of battery performance across different cycles
    译文：> 图1：不同循环次数下的电池性能对比
- 图表内部的坐标轴标签、图例文字（如 Capacity (mAh/g)）：保留英文，括号内附中文，如 Capacity (mAh/g，容量)

数学公式占位符规则（最高优先级）：
- 原文中可能含有 ⟨MATH_0⟩、⟨MATH_1⟩ 等格式的占位符，这些代表已提取的 LaTeX 公式
- 必须将这些占位符原样复制到译文对应位置，不得翻译、修改或删除
- 不要把 ⟨MATH_数字⟩ 拆分、重排或合并

数学公式处理规则（重要）：

【PDF 提取的无分隔符公式——最常见情况】
PDF 文字提取时会丢失 $ 符号，原文中公式以裸 LaTeX 形式出现，
如：J^{PPO}(\phi) = \mathbb{E}_{...} \frac{...}{...} \cdot \hat{A}_t \tag{1}
处理方法（必须执行）：
- 识别这类含有 \frac、\mathbb、\hat、\tag、^ 等 LaTeX 命令的文本
- 在翻译时用 $$ ... $$ 包裹，公式独占一行，前后各空一行
- \tag{N} 统一改为 \quad (N)（避免渲染问题）
- 示例输出：
  $$J^{PPO}(\phi) = \mathbb{E}_{(o_t, a_t) \sim \pi_{\phi_{\text{old}}}} \frac{\pi_\phi(a_t|o_t)}{\pi_{\phi_{\text{old}}}(a_t|o_t)} \cdot \hat{A}_t \quad (1)$$

【已有 $ 符号的公式】
- 行内公式 $...$：保留原格式不变
- 行间公式 $$...$$：保留原格式，独占一行，前后各空一行

【复杂多行环境（\begin{cases}、\begin{align}、\begin{matrix} 等）】
不要输出原始 LaTeX，改用方括号文字描述：
[分段函数：当 x > 0 时 $M_t = 1$，否则 $M_t = 0$]

【其他】
- PDF 提取出乱码符号：用 [公式：描述含义] 代替
- 孤立数学符号（α β γ Σ ∫ 等）直接原样保留

以下是第 ${pageNum} 页${isChunk ? "的部分内容" : "的原文"}：

${text}`;
}

// 把长文本按空行切成若干段，每段不超过 maxChunkChars，用于截断兜底翻译
function splitIntoChunks(text: string, maxChunkChars = 3000): string[] {
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  if (paragraphs.length <= 1) return [text];

  const chunks: string[] = [];
  let cur = "";
  for (const p of paragraphs) {
    if (cur && cur.length + p.length + 2 > maxChunkChars) {
      chunks.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

type AttemptResult =
  | { ok: true; text: string }
  | { ok: false; retryable: boolean; error: string };

// 单次请求 + 消费完整流，返回完整译文或失败原因（不直接转发给客户端）
async function callOnce(prompt: string, pageNum: number, apiKey: string): Promise<AttemptResult> {
  let res: Response;
  try {
    res = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        max_tokens: 16000,
        temperature: 0.1,
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(PER_ATTEMPT_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[translate-page] 第${pageNum}页 请求异常: ${msg}`, e instanceof Error ? e.stack : "");
    return { ok: false, retryable: true, error: `网络请求失败: ${msg}` };
  }

  if (!res.ok) {
    const status = res.status;
    const errBody = await res.text().catch(() => "");
    console.error(`[translate-page] 第${pageNum}页 HTTP ${status}: ${errBody.slice(0, 300)}`);
    const retryable = status === 429 || status >= 500;
    return { ok: false, retryable, error: `API 错误 ${status}: ${errBody}` };
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const thinkingBlocks = new Set<number>();
  let buffer = "";
  let text = "";
  let stopReason: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === "[DONE]") continue;
        let evt: { type?: string; index?: number; content_block?: { type?: string }; delta?: { type?: string; text?: string; stop_reason?: string } };
        try {
          evt = JSON.parse(raw);
        } catch {
          continue;
        }
        if (evt.type === "content_block_start" && evt.content_block?.type === "thinking") {
          thinkingBlocks.add(evt.index ?? -1);
        }
        if (typeof evt.index === "number" && thinkingBlocks.has(evt.index)) continue;
        if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && typeof evt.delta.text === "string") {
          text += evt.delta.text;
        }
        if (evt.type === "message_delta" && evt.delta?.stop_reason) {
          stopReason = evt.delta.stop_reason;
        }
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[translate-page] 第${pageNum}页 流读取异常: ${msg}`, e instanceof Error ? e.stack : "");
    return { ok: false, retryable: true, error: `流读取失败: ${msg}` };
  }

  console.log(`[translate-page] 第${pageNum}页 input长度=${prompt.length} stop_reason=${stopReason} 输出长度=${text.length}`);

  if (stopReason === "max_tokens") {
    return { ok: false, retryable: true, error: "输出被截断（max_tokens）" };
  }

  return { ok: true, text };
}

// 自动重试 + 指数退避：最多 3 次，1s/2s/4s；429、5xx、超时、网络错误、截断均重试
async function callWithRetry(prompt: string, pageNum: number, apiKey: string): Promise<string> {
  let lastError = "翻译失败";
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const r = await callOnce(prompt, pageNum, apiKey);
    if (r.ok) return r.text;

    lastError = r.error;
    if (!r.retryable || attempt === MAX_RETRIES) {
      throw new Error(lastError);
    }
    const delay = RETRY_DELAYS_MS[attempt - 1];
    console.warn(`[translate-page] 第${pageNum}页 第${attempt}次尝试失败（${lastError}），${delay}ms 后重试`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error(lastError);
}

// 截断重试仍失败后的降级方案：按段落切分后分别翻译再拼接
async function translateWithSplitFallback(text: string, pageNum: number, apiKey: string): Promise<string> {
  const chunks = splitIntoChunks(text);
  console.warn(`[translate-page] 第${pageNum}页 截断重试仍失败，降级为分段翻译（共${chunks.length}段）`);
  const results: string[] = [];
  for (const chunk of chunks) {
    const prompt = buildPrompt(chunk, pageNum, true);
    const translated = await callWithRetry(prompt, pageNum, apiKey);
    results.push(translated.trim());
  }
  return results.join("\n\n");
}

// 在等待较慢的翻译请求期间持续发心跳，防止 Nginx proxy_read_timeout 断开连接
async function withHeartbeat<T>(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  work: Promise<T>,
): Promise<T> {
  let stopped = false;
  const beat = (async () => {
    while (!stopped) {
      await new Promise(resolve => setTimeout(resolve, 4000));
      if (stopped) break;
      try {
        await writer.write(encoder.encode(": k\n\n"));
      } catch {
        break;
      }
    }
  })();
  try {
    return await work;
  } finally {
    stopped = true;
    await beat.catch(() => {});
  }
}

export async function POST(req: NextRequest) {
  try {
    const { pageNum, text, documentManifest } = (await req.json()) as {
      pageNum: number;
      text: string;
      documentManifest: { pageNum: number; textHash: string }[];
    };
    const textHash = createHash("sha256").update(text ?? "").digest("hex");
    const continuationPolicy = translationContinuationPolicy({
      pageNum,
      textHash,
      manifest: documentManifest,
    });

    const execute = async () => {
    const apiKey = (process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_API_KEY);
    if (!apiKey) {
      return Response.json({ error: "服务器未配置 API Key" }, { status: 500 });
    }

    // 页面无文字（如纯图片页）直接返回空流
    if (!text?.trim()) {
      return new Response("data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    const prompt = buildPrompt(text, pageNum);

    // TransformStream：先在服务端确认翻译成功（含重试/降级），期间用心跳保活，
    // 成功后再把完整译文分片发给客户端，失败则发一条 error 事件让前端标记该页失败
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    void (async () => {
      try {
        let finalText: string;
        try {
          finalText = await withHeartbeat(writer, encoder, callWithRetry(prompt, pageNum, apiKey));
        } catch (e) {
          const msg = e instanceof Error ? e.message : "翻译失败";
          if (msg.includes("截断")) {
            finalText = await withHeartbeat(writer, encoder, translateWithSplitFallback(text, pageNum, apiKey));
          } else {
            throw e;
          }
        }

        const CHUNK_SIZE = 80;
        for (let i = 0; i < finalText.length; i += CHUNK_SIZE) {
          const piece = finalText.slice(i, i + CHUNK_SIZE);
          const evt = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } };
          await writer.write(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
        }
        await writer.write(encoder.encode("data: [DONE]\n\n"));
        await writer.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "翻译失败";
        console.error(`[translate-page] 第${pageNum}页 最终失败: ${msg}`, e instanceof Error ? e.stack : "");
        try {
          const errEvt = { type: "error", error: { message: msg } };
          await writer.write(encoder.encode(`data: ${JSON.stringify(errEvt)}\n\n`));
          await writer.close();
        } catch {
          /* 连接已断开，忽略 */
        }
      }
    })();

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
    };

    return await withAiUsage(
      req,
      "translate",
      ({ used, limit }) => Response.json(
        { error: `本月全文翻译次数已用完（${used}/${limit} 次），下月 1 日自动重置` },
        { status: 429 },
      ),
      execute,
      {
        operationKey: continuationPolicy.operationKey,
        continuation: continuationPolicy.continuation,
        continuationStages: continuationPolicy.continuationStages,
      },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "请求失败，请重试";
    return Response.json({ error: msg }, { status: 500 });
  }
}
