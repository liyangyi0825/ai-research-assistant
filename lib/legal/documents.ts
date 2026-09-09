export type LegalDocumentSlug =
  | "terms"
  | "privacy"
  | "membership"
  | "refunds"
  | "ai-use"
  | "academic-integrity"
  | "invoices"
  | "support";

export type LegalSection = {
  heading: string;
  paragraphs: readonly string[];
};

export type LegalDocument = {
  slug: LegalDocumentSlug;
  title: string;
  shortTitle: string;
  summary: string;
  statusNotice: string;
  reviewNotice: string;
  sections: readonly LegalSection[];
};

export const REQUIRED_ACADEMIC_SAFETY_STATEMENTS = [
  /平台用于科研辅助/,
  /禁止论文代写/,
  /禁止伪造实验或研究数据/,
  /禁止考试作弊/,
  /禁止其他学术不端行为/,
  /AI 输出可能存在错误/,
  /自行核查引用、数据和结论/,
] as const;

const DRAFT_NOTICE = "本页面为内部评审草案，尚未正式生效。";
const LAWYER_REVIEW_NOTICE =
  "本草案不构成最终法律文件，正式文本上线前应由专业律师审核。";

export const LEGAL_DOCUMENTS: readonly LegalDocument[] = [
  {
    slug: "terms",
    title: "用户协议（草案）",
    shortTitle: "用户协议",
    summary:
      "说明用户访问和使用科研辅助平台时的基本权利、义务与行为边界。",
    statusNotice: DRAFT_NOTICE,
    reviewNotice: LAWYER_REVIEW_NOTICE,
    sections: [
      {
        heading: "适用范围",
        paragraphs: [
          "平台用于科研辅助，包括资料整理、语言处理、分析提示与内容生成等工具。用户应根据自身研究场景独立判断工具是否适用。",
          "继续访问本草案页面不代表用户已同意尚未生效的收费或会员条款。",
        ],
      },
      {
        heading: "账号与使用责任",
        paragraphs: [
          "用户应妥善保管账号信息，并对账号下发起的操作负责。不得绕过访问限制、干扰服务或侵害他人合法权益。",
          "用户不得利用平台实施违法活动，亦不得提交无权处理的个人信息、保密资料或受限制数据。",
        ],
      },
      {
        heading: "学术使用边界",
        paragraphs: [
          "禁止论文代写，禁止伪造实验或研究数据，禁止考试作弊，禁止其他学术不端行为。",
          "AI 输出可能存在错误。用户需要自行核查引用、数据和结论，并按照所在机构或期刊要求披露 AI 工具的使用情况。",
        ],
      },
    ],
  },
  {
    slug: "privacy",
    title: "隐私政策（草案）",
    shortTitle: "隐私政策",
    summary: "说明科研辅助服务可能处理的信息类型、用途与用户选择。",
    statusNotice: DRAFT_NOTICE,
    reviewNotice: LAWYER_REVIEW_NOTICE,
    sections: [
      {
        heading: "信息处理范围",
        paragraphs: [
          "为提供账号、科研任务、用量记录和安全保障功能，平台可能处理账号资料、操作日志、设备与网络信息，以及用户主动提交的内容。",
          "用户不应上传无权处理的敏感个人信息、未公开研究秘密或依法不得交由第三方处理的数据。",
        ],
      },
      {
        heading: "处理目的与保存",
        paragraphs: [
          "相关信息仅用于提供服务、保障安全、处理咨询、记录用量和履行适用的法定义务。",
          "信息保存期限将依据实现处理目的所必需的最短期限、法定义务及安全需要确定；到期后依法删除或匿名化。",
        ],
      },
      {
        heading: "用户权利与联系",
        paragraphs: [
          "用户可通过本页面列明的联系渠道咨询信息访问、更正、删除和账号注销事宜，平台将依法核验并处理。",
          "本草案不替代针对具体第三方模型或基础设施另行提供的必要说明。",
        ],
      },
    ],
  },
  {
    slug: "membership",
    title: "会员服务协议（草案）",
    shortTitle: "会员服务",
    summary:
      "本收费条款仅供开发与合规评审；当前不构成会员销售、付款邀请或服务承诺。",
    statusNotice: "会员收费条款为草案，当前未正式生效，收费功能未开放。",
    reviewNotice: LAWYER_REVIEW_NOTICE,
    sections: [
      {
        heading: "会员服务范围",
        paragraphs: [
          "未来会员权益、有效期、使用额度和适用功能将以结算前由服务端展示并经用户确认的商品信息为准。",
          "会员不代表科研成果质量、论文录用、评审通过或任何特定结果的保证。",
        ],
      },
      {
        heading: "计费与续期",
        paragraphs: [
          "当前仅进行 Mock 支付开发测试，不向普通线上用户收费。正式计费方式、价格和生效时间将另行公布。",
          "本阶段不启用自动扣款或自动续费；未来如提供相关功能，将在取得用户单独明确授权后实施。",
        ],
      },
      {
        heading: "合理使用",
        paragraphs: [
          "会员服务仍受学术诚信、内容安全与合理使用规则约束。违规使用可能导致任务被拒绝或账号能力受限。",
          "用户应核对 AI 生成内容，不得将会员权益用于论文代写、数据造假或其他学术不端。",
        ],
      },
    ],
  },
  {
    slug: "refunds",
    title: "退款政策（草案）",
    shortTitle: "退款政策",
    summary:
      "本政策仅描述拟议的退款申请与审核框架；当前收费未开放，不产生实际退款承诺。",
    statusNotice: "退款条款为草案，当前未正式生效，收费功能未开放。",
    reviewNotice: LAWYER_REVIEW_NOTICE,
    sections: [
      {
        heading: "申请范围",
        paragraphs: [
          "未来正式收费后，用户可针对符合届时有效政策的已支付订单提出退款申请，并说明订单、原因及必要凭证。",
          "已实际消耗的数字化服务、已使用额度和法律另有规定的情形，可能影响可退款范围。",
        ],
      },
      {
        heading: "审核与原路退回",
        paragraphs: [
          "平台将核对订单状态、权益使用和支付记录；审核通过后原则上按原支付路径办理，具体到账时间取决于支付机构。",
          "重复申请、金额篡改或与订单不一致的请求不会改变后端订单记录。",
        ],
      },
      {
        heading: "法定权利",
        paragraphs: [
          "本草案不限制用户依据适用法律享有的权利。正式规则将说明申请期限、处理时限和争议处理方式。",
        ],
      },
    ],
  },
  {
    slug: "ai-use",
    title: "AI 使用声明（草案）",
    shortTitle: "AI 使用声明",
    summary: "帮助科研用户理解生成式 AI 的能力边界与核查责任。",
    statusNotice: DRAFT_NOTICE,
    reviewNotice: LAWYER_REVIEW_NOTICE,
    sections: [
      {
        heading: "能力边界",
        paragraphs: [
          "AI 输出可能存在错误、遗漏、虚构引用、过时信息或偏差，不能替代实验验证、专业判断、伦理审查或法律意见。",
          "模型输出具有概率性，相同输入可能产生不同结果。",
        ],
      },
      {
        heading: "用户核查",
        paragraphs: [
          "用户需要自行核查引用、数据和结论，包括回到原始文献验证出处、作者、年份、页码、统计方法与实验条件。",
          "对医疗、法律、安全或其他高风险研究结论，应取得具备相应资质的专业人员复核。",
        ],
      },
      {
        heading: "透明使用",
        paragraphs: [
          "用户应遵守所在学校、科研机构、资助方、会议和期刊关于 AI 使用与披露的规则，不得把 AI 输出冒充为未经辅助的原创工作。",
        ],
      },
    ],
  },
  {
    slug: "academic-integrity",
    title: "学术诚信政策（草案）",
    shortTitle: "学术诚信",
    summary: "界定科研辅助工具可接受与不可接受的使用方式。",
    statusNotice: DRAFT_NOTICE,
    reviewNotice: LAWYER_REVIEW_NOTICE,
    sections: [
      {
        heading: "允许的辅助",
        paragraphs: [
          "平台可用于启发研究思路、整理公开资料、改进表达和辅助检查，但用户必须保持对研究设计、证据和最终成果的实质控制。",
        ],
      },
      {
        heading: "明确禁止",
        paragraphs: [
          "禁止论文代写，禁止伪造实验或研究数据，禁止考试作弊，禁止其他学术不端行为。",
          "不得虚构参考文献、篡改研究结果、冒用他人成果，或绕过学校、机构和出版方的诚信要求。",
        ],
      },
      {
        heading: "记录与处置",
        paragraphs: [
          "平台可在法律允许范围内采取风险识别、限制使用和保留必要安全记录等措施。对涉嫌违法或严重侵权的行为，将依法处理。",
        ],
      },
    ],
  },
  {
    slug: "invoices",
    title: "发票说明（草案）",
    shortTitle: "发票说明",
    summary: "说明未来正式收费后的发票申请框架；当前不提供收费开票。",
    statusNotice: "发票规则为草案，当前未正式生效，收费功能未开放。",
    reviewNotice: LAWYER_REVIEW_NOTICE,
    sections: [
      {
        heading: "申请条件",
        paragraphs: [
          "正式收费开放后，符合条件的已支付订单可依届时页面提示申请发票。当前 Mock 测试订单不构成真实交易，不开具发票。",
        ],
      },
      {
        heading: "信息核对",
        paragraphs: [
          "申请人应准确提供发票抬头、识别号、接收方式及订单信息；发票金额以服务端确认的实际支付金额为准。",
        ],
      },
      {
        heading: "更正与咨询",
        paragraphs: [
          "如需更正发票信息，用户可通过列明的联系渠道提交申请；能否更正及办理方式以税务规则和正式政策为准。",
        ],
      },
    ],
  },
  {
    slug: "support",
    title: "客服与投诉说明（草案）",
    shortTitle: "客服与投诉",
    summary: "说明咨询、投诉与争议反馈的拟议受理方式。",
    statusNotice: DRAFT_NOTICE,
    reviewNotice: LAWYER_REVIEW_NOTICE,
    sections: [
      {
        heading: "受理事项",
        paragraphs: [
          "用户可就账号、隐私、科研辅助功能、内容安全及未来的订单、退款或发票事项提出咨询与投诉。",
        ],
      },
      {
        heading: "提交信息",
        paragraphs: [
          "为便于核验，反馈可包含问题描述、发生时间及必要的订单编号或截图。请勿在普通邮件中发送密码、密钥或不必要的敏感数据。",
        ],
      },
      {
        heading: "处理与反馈",
        paragraphs: [
          "平台将在核验身份和事实后按照适用规则处理。复杂事项可能需要补充材料，具体服务时限将在正式文本中明确。",
        ],
      },
    ],
  },
];

export function getLegalDocument(slug: LegalDocumentSlug): LegalDocument {
  const document = LEGAL_DOCUMENTS.find((item) => item.slug === slug);
  if (!document) {
    throw new Error(`Unknown legal document: ${slug}`);
  }
  return document;
}
