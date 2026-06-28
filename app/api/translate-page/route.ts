// 按页翻译接口：每次翻译 PDF 的一页
// 只在第一页（isFirst=true）检查并记录用量，整篇 PDF 只消耗一次配额
import { NextRequest } from "next/server";
import { after } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { checkUsageLimit, insertUsageRecord } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const apiKey = (process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_API_KEY);
    if (!apiKey) {
      return Response.json({ error: "服务器未配置 API Key" }, { status: 500 });
    }

    const { pageNum, text, isFirst } = (await req.json()) as {
      pageNum: number;
      text: string;
      isFirst: boolean;
    };

    // 只在第一页检查用量，整篇 PDF 只扣一次配额
    let userId: string | null = null;
    if (isFirst) {
      const { allowed, used, limit, userId: uid } = await checkUsageLimit("translate");
      if (!allowed) {
        return Response.json(
          { error: `本月全文翻译次数已用完（${used}/${limit} 次），下月 1 日自动重置` },
          { status: 429 },
        );
      }
      userId = uid;
    }

    // 页面无文字（如纯图片页）直接返回空流
    if (!text?.trim()) {
      return new Response("data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    const prompt = `本页文字从双栏PDF提取，可能存在左右栏交叉混排。
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

以下是第 ${pageNum} 页的原文：

${text}`;

    const anthropicRes = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        max_tokens: 8000,
        temperature: 0.3,
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      return Response.json(
        { error: `API 错误 ${anthropicRes.status}: ${errBody}` },
        { status: 500 },
      );
    }

    // 第一页成功后记录一次用量（整篇 PDF 只计一次）
    if (isFirst && userId) {
      after(async () => {
        await insertUsageRecord({
          userId: userId!,
          actionType: "translate",
          tokensInput: 0,
          tokensOutput: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        });
      });
    }

    // TransformStream 透传 + 心跳，防止 Nginx proxy_read_timeout 断开 SSE 流
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let firstChunkLogged = false;

    void (async () => {
      const reader = anthropicRes.body!.getReader();
      const thinkingBlocks = new Set<number>();
      let lastHeartbeat = Date.now();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // 每 5 秒发一次心跳，防止 Nginx proxy_read_timeout 断开
          if (Date.now() - lastHeartbeat > 5000) {
            await writer.write(encoder.encode(": k\n\n"));
            lastHeartbeat = Date.now();
          }

          const chunk = decoder.decode(value, { stream: true });
          if (!firstChunkLogged) {
            console.log("[translate-page] first chunk:", chunk.slice(0, 200));
            firstChunkLogged = true;
          }
          sseBuffer += chunk;
          const lines = sseBuffer.split("\n");
          sseBuffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) {
              await writer.write(encoder.encode(line + "\n"));
              continue;
            }
            const raw = line.slice(6).trim();
            if (!raw || raw === "[DONE]") {
              await writer.write(encoder.encode(line + "\n"));
              continue;
            }
            try {
              const evt = JSON.parse(raw);
              if (evt.type === "content_block_start" && evt.content_block?.type === "thinking") {
                thinkingBlocks.add(evt.index ?? -1);
              }
              if (typeof evt.index === "number" && thinkingBlocks.has(evt.index)) continue;
              await writer.write(encoder.encode(line + "\n"));
            } catch { await writer.write(encoder.encode(line + "\n")); }
          }
        }
        await writer.close();
      } catch (e) {
        await writer.abort(e);
      }
    })();

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "请求失败，请重试";
    return Response.json({ error: msg }, { status: 500 });
  }
}
