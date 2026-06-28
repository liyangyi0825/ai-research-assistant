// POST /api/data-clean
// 输入：{ headers: string[], sample: string[][], totalRows: number }
// 输出：{ columns, issues, rules, charts } 清洗方案 JSON
// 只发前 100 行样本给 Claude，清洗本身在前端执行

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

    const { allowed, used, limit, userId } = await checkUsageLimit("data_clean");
    if (!allowed) {
      return Response.json(
        { error: `本月数据清洗次数已用完（${used}/${limit} 次），下月 1 日自动重置` },
        { status: 429 }
      );
    }

    const { headers, sample, totalRows } = await req.json() as {
      headers: string[];
      sample: string[][];
      totalRows: number;
    };

    if (!headers?.length || !sample?.length) {
      return Response.json({ error: "数据为空" }, { status: 400 });
    }

    const csvHeader = headers.join(",");
    const csvRows   = sample.slice(0, 100).map(row => row.join(",")).join("\n");

    const anthropicRes = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key":          apiKey,
        "anthropic-version":  "2023-06-01",
        "content-type":       "application/json",
      },
      body: JSON.stringify({
        model:       "deepseek-v4-pro",
        max_tokens:  8000,
        temperature: 0.1,
        messages: [{
          role: "user",
          content: `你是数据科学家，分析以下实验数据并制定清洗方案。

请先根据数据的列名、数值范围和业务含义推断数据单位，不要假设数值必须在 0-100 范围内。
如果数据是电力（MW/kW/GW）、温度（℃/K）、重量（kg/t）、距离（m/km）等物理量，合计或单值超过 100 是完全正常的。
只有在列名明确包含"占比"、"率"、"%"、"百分比"等字样时，才将超过 100 视为可能的异常。
在报告问题时，说明推断的数据单位和业务场景。

数据概况：共 ${totalRows} 行，${headers.length} 列。样本（前 ${sample.length} 行）：

${csvHeader}
${csvRows}

以纯 JSON 返回（不加代码块，不加任何说明文字），格式如下：

{
  "columns": [
    { "original": "原始列名", "renamed": "规范列名（含单位，如 温度(℃)）", "type": "datetime|numeric|category|text" }
  ],
  "issues": [
    "具体问题描述，含示例值或行数（并说明推断的数据单位和业务场景）"
  ],
  "rules": [
    只使用以下 6 种规则类型（id 格式 r1/r2/r3...），每条一个对象：
    {"id":"r1","type":"drop_empty_rows","description":"删除完全空白的行（共N行）"}
    {"id":"r2","type":"rename_columns","description":"规范化所有列名"}
    {"id":"r3","type":"strip_unit","column":"重命名后的列名","unit":"℃","description":"去掉数字后的单位后缀"}
    {"id":"r4","type":"drop_missing","column":"重命名后的列名","description":"删除该列有缺失值的行（共N行）"}
    {"id":"r5","type":"drop_outliers","column":"重命名后的列名","min":最小合理值,"max":最大合理值,"description":"删除超出合理物理范围的异常值（范围应基于数据实际业务含义，而非固定0-100）"}
    {"id":"r6","type":"parse_number","column":"重命名后的列名","description":"将字符串列强制转为数字"}
  ],
  "charts": [
    推荐 1-2 个最有意义的图表（id 格式 c1/c2...）：
    {"id":"c1","type":"line|bar|scatter","x":"重命名后的列名","y":["列名1","列名2","列名3"],"title":"图表标题"}
  ]
}

重要约束：
- rules 和 charts 中引用的列名必须用 renamed 后的名称（非原始列名）
- rename_columns 必须排在其他含 column 字段的规则之前
- 数据良好则省略不需要的规则，至少包含 rename_columns
- 不要使用 6 种之外的规则类型
- drop_outliers 的 min/max 必须基于该列的实际业务含义设定，禁止默认套用 0-100

列名重命名规则（rename 时必须遵守）：
- 如果原始列名是 Excel 日期序号（通常是 40000-50000 之间的整数，如 44927、46023、46112），
  必须将其转换为中文日期格式，例如：44927 → "1月1日"、46023 → "1月1日"、46063 → "2月10日"、46112 → "3月31日"。
  Excel 日期序号从 1900-01-01 = 1 开始计数，请精确换算后用"M月D日"格式命名，让用户能直接看出是哪天的数据。
  不要用数字编号（如"列1"、"数据1"）代替日期，也不要保留原始数字序号。

图表系列规则（charts 时必须遵守）：
- 当数据中有多列同类型的数值（如多个日期的测量值），chart.y 数组必须包含所有这些列的 renamed 名称，不能只填一列。
- 确保 chart.y 中每个列名与 columns 里对应的 renamed 完全一致（大小写、符号相同），否则图表无法显示该系列。
- 多系列折线图是展示多日期对比的首选，不要省略任何一个日期系列。`,
        }],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      console.error("[data-clean] Anthropic error:", err);
      return Response.json({ error: `AI 服务错误（${anthropicRes.status}），请稍后重试` }, { status: 500 });
    }

    const data = await anthropicRes.json();

    if (userId) {
      after(async () => {
        await insertUsageRecord({
          userId,
          actionType:          "data_clean",
          tokensInput:         data.usage?.input_tokens ?? 0,
          tokensOutput:        data.usage?.output_tokens ?? 0,
          cacheCreationTokens: data.usage?.cache_creation_input_tokens ?? 0,
          cacheReadTokens:     data.usage?.cache_read_input_tokens ?? 0,
        });
      });
    }

    const textBlock = data.content?.find((b: { type: string }) => b.type === "text");
    let raw: string = textBlock?.text ?? "";
    console.log("[data-clean] raw:", raw.slice(0, 200));
    // 防御：去掉 ```json 代码块 和 thinking 残留内容
    raw = raw.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();

    let result: unknown;
    try {
      result = JSON.parse(raw);
    } catch {
      console.error("[data-clean] JSON parse failed, raw:", raw.slice(0, 300));
      return Response.json({ error: "AI 返回格式异常，请重试" }, { status: 500 });
    }

    const r = result as Record<string, unknown>;
    if (!Array.isArray(r.columns) || !Array.isArray(r.rules) || !Array.isArray(r.charts)) {
      return Response.json({ error: "AI 返回结构不完整，请重试" }, { status: 500 });
    }

    return Response.json(result);
  } catch (error) {
    console.error("[data-clean]", error);
    return Response.json({ error: "分析失败，请重试" }, { status: 500 });
  }
}
