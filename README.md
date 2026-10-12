# ShipLog · 码上说

> 把每天的 git 提交，变成能直接发出去的开发日记。
> Turn today's commits into build-in-public posts — without making anything up.

独立开发者都知道“边做边说（build in public）”能带来用户，但写帖子比写代码还累，于是常常干脆不发。其实素材每天都在 git 里：做了什么功能、修了什么坑、哪段代码写得漂亮。

ShipLog 读取你的提交，让 AI 挑出“今天值得讲的故事”，再按你的说话风格写成**即刻、小红书、X、V2EX、更新日志、Product Hunt** 的草稿，同时生成可直接配图的**开发数据卡**和**代码片段卡**。

## 它和“让 ChatGPT 帮我写个帖子”有什么不同

|                    | ShipLog                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| **不编数据**       | 草稿里的每个数字都必须能在提交信息、diff 或 git 统计中找到出处。“性能提升 40%”这类编造会被拦下，自动修一轮，修不好就在页面上标红。 |
| **不泄露密钥**     | 发给 AI 之前，先排除 `.env`、锁文件、二进制和构建产物，并把 diff 里疑似密钥的内容替换为 `[已脱敏]`。发送前可以预览全部内容。       |
| **符合平台规则**   | X 按加权字数计算（中文算 2、链接算 23），小红书标题不超过 20 字，Product Hunt 标语不超过 60 字等，编辑时实时计数。                 |
| **有出处的故事**   | AI 把零散提交整理成“故事”，每条事实都标注来源提交，可以点回去核对。                                                                |
| **不用 AI 也有用** | 没有配置 API Key 或额度用完时，照样生成按 Conventional Commits 分组的更新日志和数据卡，并明确标注“未使用 AI”。                     |
| **养成习惯**       | 开发与分享的打卡日历、连续天数，以及自动识别的里程碑（第 100 次提交、新版本发布、项目周年）。                                      |

## 快速开始

需要 Node.js 22.13 及以上版本（使用内置的 `node:sqlite`），以及 git。

```bash
npm install
cp .env.example .env      # 填写 ANTHROPIC_API_KEY 才会启用 AI；不填也能用基线模式
npm run dev               # http://127.0.0.1:8792
```

打开页面后，在“设置”里连接仓库：

- **本地仓库**：填写绝对路径。开发模式下默认允许读取当前目录的上级目录；其他位置需要用 `SHIPLOG_LOCAL_ROOTS` 显式开启。
- **GitHub 仓库**：公开仓库可以直接读取。私有仓库需要一个[细粒度只读令牌](https://github.com/settings/personal-access-tokens/new)，权限只勾选 Contents 和 Metadata 的 Read-only。令牌用 AES-256-GCM 加密后存入本地 SQLite。

### 命令行

```bash
npm run cli -- draft --repo . --since 24h --platforms jike,x,xiaohongshu
npm run cli -- changelog --repo . --since 7d       # 只生成更新日志，不调用 AI
npm run cli -- preview --repo . --since 24h        # 查看将发送给 AI 的内容（已脱敏），不调用 AI
npm run cli -- card --repo . --since 7d --out card.svg --theme dark
```

构建后也可以直接运行 `node dist-server/shiplog.js …`。

## 工作流程

```
git 提交（本地 / GitHub）
  → 过滤：排除锁文件、.env、二进制、构建产物；截断超长 diff
  → 脱敏：密钥、令牌、私钥、URL 中的密码
  → 基线：Conventional Commits 更新日志、里程碑、数据卡（确定性，不用 AI）
  → AI 第一步：把提交整理成“故事”，每条事实附来源 SHA（无效 SHA、无出处的数字会被丢弃）
  → AI 第二步：按风格卡和平台规则写草稿
  → 确定性检查：平台字数、无出处数字、密钥扫描、事实引用
  → 修订一轮：只把没通过检查的草稿连同问题发回给 AI
  → 保存、编辑后重新检查、标记已发布、记入打卡
```

AI 调用使用 Claude（`@anthropic-ai/sdk`）：

- 结构化输出：`messages.parse` + Zod。
- 默认模型 `claude-opus-5-5`，effort 默认为 `medium`。
- 系统提示做了提示缓存。
- 开启了服务端拒答回退（`fallbacks: "default"`）。
- `refusal` 和 `max_tokens` 两种情况都有明确的错误提示。

模型和 effort 可以通过 `SHIPLOG_MODEL`、`SHIPLOG_EFFORT` 配置。

## 商业模式（假设，待验证）

| 套餐             | 内容                                                                       | 价格假设        |
| ---------------- | -------------------------------------------------------------------------- | --------------- |
| 免费版           | 1 个仓库，每月 10 次 AI 生成，可以手动编辑风格卡；更新日志和数据卡不限次数 | ¥0              |
| Pro              | 不限仓库和生成次数，可从过去的帖子中学习风格                               | 约 $9 或 ¥39/月 |
| 团队版（规划中） | 开源项目和小团队的自动更新日志、周报                                       | 按席位收费      |

目前代码里已经有套餐限制（`SHIPLOG_PLAN=free|pro`）和逐次用量计量（token 数和美元成本，见“设置 → 套餐与用量”）。支付和账号体系还没有接入。

**单位成本**：一次生成通常调用 2 次模型（理解 + 写作），偶尔有 1 次修订。按 Opus 5.5 的价格（每百万 token：输入 $4、输出 $20），一天的提交量**估算**每次约 $0.10–0.30。这只是估算，实际以应用内的计量为准：

- 免费用户每月最多 10 次，成本上限约 $3。
- Pro 用户如果每天生成 1–2 次，模型成本可能接近订阅价。定价前需要用真实计量数据核算。
- 可以把 `SHIPLOG_MODEL` 换成更便宜的模型来降低成本，但要先确认草稿质量。这个取舍需要产品决策。

## 配置

见 [`.env.example`](.env.example)。常用项：

| 变量                               | 说明                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                | Claude API Key。不填则使用基线模式。                                                           |
| `SHIPLOG_MODEL` / `SHIPLOG_EFFORT` | 模型（默认 `claude-opus-5-5`）和思考力度（默认 `medium`）。                                    |
| `SHIPLOG_ENCRYPTION_KEY`           | 加密 GitHub 令牌用的密钥，至少 24 位。生产环境必填；开发环境会自动生成 `var/.encryption-key`。 |
| `SHIPLOG_APP_TOKEN`                | 设置后，除健康检查外的所有接口都需要 `Authorization: Bearer`。                                 |
| `SHIPLOG_LOCAL_ROOTS`              | 允许读取的本地仓库根目录。生产环境不设置时，本地仓库功能关闭。                                 |
| `SHIPLOG_PLAN`                     | `free` 或 `pro`。                                                                              |
| `HOST` / `PORT`                    | 默认 `127.0.0.1:8792`。                                                                        |

## 开发

```bash
npm run typecheck
npm run lint
npm test              # Vitest：用临时 git 仓库、内存 SQLite 和 Fake 模型，不调用真实 API
npm run build && npm start
```

代码结构：

- `src/shared/`：前后端共享的类型（Zod）和平台规则。
- `src/server/sources/`：本地 git 和 GitHub 采集。
- `src/server/prep/`：过滤与脱敏。
- `src/server/ai/`：模型调用、提示词、理解 / 写作 / 风格学习。
- `src/server/guards/`：事实和平台检查。
- `src/server/cards/`：数据卡和代码卡（SVG）。
- `src/server/db/`：SQLite、迁移、加密凭证。
- `src/server/services/`：业务编排、套餐、时间窗口。
- `src/cli/`：命令行。
- `src/client/`：React 界面。

## 路线图

- GitHub OAuth 登录与多用户
- Stripe 支付
- 定时生成，通过邮件或 Telegram 提醒
- 通过 X、Bluesky 的 API 直接发布
- 回填发布后的互动数据，学习哪类故事最受欢迎
- 团队版
