# ShipLog · 码上说

> 把每天的 git 提交，变成能直接发出去的开发日记。
> Turn today's commits into build-in-public posts — without making anything up.

独立开发者都知道“边做边说（build in public）”能带来用户，但写帖子比写代码还累，于是常常干脆不发。其实素材每天都在 git 里：做了什么功能、修了什么坑、哪段代码写得漂亮。

ShipLog 读取你的提交，让 AI 挑出“今天值得讲的故事”，再按你的说话风格写成**即刻、小红书、X、V2EX、更新日志、Product Hunt** 的草稿，同时生成可直接配图的**开发数据卡**和**代码片段卡**。每天到点自动写好、发到你的邮箱或飞书/Slack；发出去之后填上点赞和评论，它会记住哪类内容最受欢迎，下次写得更像你最好的那几篇。

## 它和“让 ChatGPT 帮我写个帖子”有什么不同

|                    | ShipLog                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **不编数据**       | 草稿里的每个数字都必须能在提交信息、diff 或 git 统计中找到出处。“性能提升 40%”这类编造会被拦下，自动修一轮，修不好就在页面上标红。         |
| **不乱引代码**     | 草稿里用反引号引用的代码、命令和文件名，必须在提交里逐字出现；AI 省字、改写都过不了检查。                                                  |
| **不泄露密钥**     | 发给 AI 之前，先排除 `.env`、锁文件、二进制和构建产物，并把 diff 里疑似密钥的内容替换为 `[已脱敏]`。发送前可以预览全部内容。               |
| **符合平台规则**   | X 按加权字数计算（中文算 2、链接算 23），小红书标题不超过 20 字，Product Hunt 标语不超过 60 字等，编辑时实时计数。                         |
| **有出处的故事**   | AI 把零散提交整理成“故事”，每条事实都标注来源提交，可以点回去核对。                                                                        |
| **到点送到手边**   | 每天在你设定的时间（按你的时区）自动生成，通过邮件或 Webhook（飞书、Slack、Discord、通用 JSON）提醒你，链接直接打开那天的草稿。            |
| **越用越懂你**     | 发布后记录点赞、评论、转发、收藏，ShipLog 告诉你哪类故事表现最好；Pro 版写新草稿时会参考你互动最好的帖子的开头、结构和节奏（不照搬内容）。 |
| **不用 AI 也有用** | 没有配置 API Key 或额度用完时，照样生成按 Conventional Commits 分组的更新日志和数据卡，并明确标注“未使用 AI”。                             |
| **养成习惯**       | 开发与分享的打卡日历、连续天数，以及自动识别的里程碑（第 100 次提交、新版本发布、项目周年）。                                              |

## 两种运行方式

|            | 自用模式（默认）                                | 多用户模式                                                     |
| ---------- | ----------------------------------------------- | -------------------------------------------------------------- |
| 何时启用   | 没有配置 `GITHUB_CLIENT_ID`                     | 配置了 `GITHUB_CLIENT_ID` 和 `GITHUB_CLIENT_SECRET`            |
| 登录       | 无；可用 `SHIPLOG_APP_TOKEN` 给整个服务加一把锁 | “用 GitHub 登录”，服务端会话（HttpOnly Cookie）                |
| 仓库       | 本地仓库 + GitHub 仓库（细粒度只读令牌）        | 只有 GitHub 仓库（登录授权，私有仓库需额外授权）；本地仓库关闭 |
| 套餐       | `SHIPLOG_PLAN=free` 或 `pro`                    | 每个用户各自的套餐，通过 Stripe 订阅升级                       |
| 未登录访问 | —                                               | 显示介绍页和定价                                               |

## 快速开始

需要 Node.js 22.13 及以上版本（使用内置的 `node:sqlite`），以及 git。

```bash
npm install
cp .env.example .env      # 填写 ANTHROPIC_API_KEY 才会启用 AI；不填也能用基线模式
npm run dev               # http://127.0.0.1:8792
```

打开页面后，在“设置”里连接仓库：

- **本地仓库**：填写绝对路径。开发模式下默认允许读取当前目录的上级目录；其他位置需要用 `SHIPLOG_LOCAL_ROOTS` 显式开启。
- **GitHub 仓库**：公开仓库可以直接读取。私有仓库需要一个[细粒度只读令牌](https://github.com/settings/personal-access-tokens/new)，权限只勾选 Contents 和 Metadata 的 Read-only。令牌用 AES-256-GCM 加密后存入 SQLite。

### Docker

```bash
cp .env.example .env      # 至少填 SHIPLOG_ENCRYPTION_KEY；需要 AI 再填 ANTHROPIC_API_KEY
docker compose up -d      # http://localhost:8792
```

- 数据库在 `shiplog-data` 卷里（容器内 `/data/shiplog.db`），记得定期备份；`SHIPLOG_ENCRYPTION_KEY` 要和备份分开保存，丢了它就解不开已保存的令牌。
- 自用模式想读本地仓库：在 `docker-compose.yml` 里把代码目录只读挂到 `/repos`，并在 `.env` 里设置 `SHIPLOG_LOCAL_ROOTS=/repos`。
- 镜像以非 root 用户运行，带健康检查（`/api/health`）；收到停止信号会先处理完进行中的请求再关闭数据库。

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
  → AI 第二步：按风格卡、平台规则和你过往表现最好的帖子写草稿
  → 确定性检查：平台字数、无出处数字、引用代码是否逐字存在、密钥扫描、事实引用
  → 修订一轮：只把没通过检查的草稿连同问题发回给 AI
  → 保存、编辑后重新检查、标记已发布、记入打卡
  → 发布后记录互动数据 → 洞察 → 下一次写作参考
```

AI 调用使用 Claude（`@anthropic-ai/sdk`）：

- 结构化输出：`messages.parse` + Zod。
- 默认模型 `claude-opus-5-5`，effort 默认为 `medium`。
- 系统提示做了提示缓存。
- 开启了服务端拒答回退（`fallbacks: "default"`）。
- `refusal` 和 `max_tokens` 两种情况都有明确的错误提示。

模型和 effort 可以通过 `SHIPLOG_MODEL`、`SHIPLOG_EFFORT` 配置。

### 每日定时生成（Pro）

在“定时”页设置时间、时区、仓库、平台和读取多长时间内的提交。到点后：

1. 读取这段时间的提交并生成草稿；没有新提交时默认静默跳过。
2. 通过邮件（需要服务器配置 `SMTP_URL`）和/或 Webhook 发送摘要和链接。
3. 运行记录里能看到每次的结果（成功、跳过、失败及原因）。

同一个用户每个本地日期最多运行一次（数据库里原子认领，多实例共享数据库也不会重复）。在当天的时间点之后才开启或修改时间，从第二天开始运行。

Webhook 地址加密保存，只允许 `https://` 和公网地址，不跟随重定向，防止被用来访问服务器所在的内网。

### 发布效果与学习

发布后，在草稿下方的“发布后的数据”里填写点赞、评论、转发、收藏、浏览和帖子链接。“历史”页顶部会显示：

- 总数和各平台的平均互动分、最高分。互动分 = 赞 + 2×评论 + 3×转发 + 2×收藏，只在同一平台内比较。
- 哪类故事（新功能、修复、性能……）高于你在同一平台的平均表现。
- 表现最好的帖子，以及已经发布但还没填数据的帖子。

Pro 版写新草稿时，会把你在每个平台互动最好的 2 篇帖子作为风格参考，并告诉 AI 读者更喜欢哪类故事。参考帖里的数字不在这次的提交里，所以照搬会被事实检查拦下。

## 商业模式（假设，待验证）

| 套餐             | 内容                                                                                           | 价格假设        |
| ---------------- | ---------------------------------------------------------------------------------------------- | --------------- |
| 免费版           | 1 个仓库，每月 10 次 AI 生成，手动编辑风格卡，记录发布数据和查看洞察；更新日志和数据卡不限次数 | ¥0              |
| Pro              | 不限仓库和生成次数，从过去的帖子学习风格，每日定时生成与提醒，AI 参考你表现最好的帖子          | 约 $9 或 ¥39/月 |
| 团队版（规划中） | 开源项目和小团队的自动更新日志、周报                                                           | 按席位收费      |

多用户模式下通过 Stripe 订阅升级（Checkout 付款、客户门户管理订阅和发票、Webhook 同步状态）。自用模式用 `SHIPLOG_PLAN` 决定套餐。

**单位成本**：一次生成调用 2 次模型（理解 + 写作），偶尔有 1 次修订。用本项目自己的提交实测，每次约 **$0.15–0.17**（Opus 5.5，每百万 token：输入 $4、输出 $20），应用内“设置 → 套餐与用量”有逐次计量：

- 免费用户每月最多 10 次，成本上限约 $2。
- Pro 用户如果每天定时生成 1 次，模型成本约 $5/月，$9 的订阅有余量；每天手动多次生成会接近订阅价。定价前需要用真实计量数据核算。
- 可以把 `SHIPLOG_MODEL` 换成更便宜的模型来降低成本，但要先确认草稿质量。这个取舍需要产品决策。

## 部署多用户版本

1. **GitHub OAuth App**：GitHub → Settings → Developer settings → OAuth Apps → New。Homepage 填你的域名，回调地址填 `${PUBLIC_BASE_URL}/auth/github/callback`。把 Client ID 和 Secret 填进 `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`。
2. **公开地址**：`PUBLIC_BASE_URL` 填用户访问的 https 地址。登录回调、付款跳转和提醒里的链接都用它，Cookie 也会因此带上 `Secure`。在前面放一个负责 TLS 的反向代理（Caddy、Nginx、云负载均衡）。
3. **加密密钥**：`SHIPLOG_ENCRYPTION_KEY` 至少 24 位随机字符。多用户模式下没有它服务不会启动。
4. **Stripe**：创建一个按月订阅的价格，把 `price_…` 填进 `STRIPE_PRICE_ID`，密钥填进 `STRIPE_SECRET_KEY`。添加 Webhook 端点 `${PUBLIC_BASE_URL}/api/billing/webhook`，订阅 `checkout.session.completed`、`customer.subscription.created`、`customer.subscription.updated`、`customer.subscription.deleted` 四个事件，签名密钥填进 `STRIPE_WEBHOOK_SECRET`。在 Stripe 后台开启客户门户。
5. **邮件提醒（可选）**：`SMTP_URL`（例如 `smtps://user:pass@smtp.example.com:465`）和 `SMTP_FROM`。
6. 启动后看日志：配置不完整或会在之后出问题的地方（比如 `PUBLIC_BASE_URL` 还是本机地址），启动时会直接提示。

服务是单进程 + SQLite，适合单台机器。定时任务内置在进程里（`SHIPLOG_SCHEDULER=off` 可关闭），多实例共享同一个数据库文件时也不会重复运行。

## 配置

见 [`.env.example`](.env.example)。

| 变量                                                              | 说明                                                                                                |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                                               | Claude API Key。不填则使用基线模式。                                                                |
| `SHIPLOG_MODEL` / `SHIPLOG_EFFORT`                                | 模型（默认 `claude-opus-5-5`）和思考力度（默认 `medium`）。                                         |
| `SHIPLOG_ENCRYPTION_KEY`                                          | 加密令牌和 Webhook 地址的密钥，至少 24 位。生产环境必填；开发环境会自动生成 `var/.encryption-key`。 |
| `PUBLIC_BASE_URL`                                                 | 用户访问的地址，用于登录回调、付款跳转和提醒链接。                                                  |
| `HOST` / `PORT`                                                   | 默认 `127.0.0.1:8792`（Docker 镜像里是 `0.0.0.0`）。                                                |
| `SHIPLOG_DB_PATH`                                                 | SQLite 文件位置，默认 `var/shiplog.db`。                                                            |
| `SHIPLOG_APP_TOKEN`                                               | 自用模式：设置后，除健康检查外的所有接口都需要 `Authorization: Bearer`。                            |
| `SHIPLOG_LOCAL_ROOTS`                                             | 自用模式：允许读取的本地仓库根目录。生产环境不设置时，本地仓库功能关闭。                            |
| `SHIPLOG_PLAN`                                                    | 自用模式的套餐：`free` 或 `pro`。                                                                   |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`                       | 填写后启用 GitHub 登录和多用户模式。                                                                |
| `GITHUB_API_BASE_URL`                                             | GitHub Enterprise 用户改成自己的 API 地址。                                                         |
| `STRIPE_SECRET_KEY` / `STRIPE_PRICE_ID` / `STRIPE_WEBHOOK_SECRET` | 多用户模式的付款，三个都填才会启用。                                                                |
| `SHIPLOG_SCHEDULER`                                               | 设为 `off` 关闭内置定时任务。                                                                       |
| `SMTP_URL` / `SMTP_FROM`                                          | 邮件提醒。                                                                                          |

## 安全

- 会话令牌只在数据库里存哈希；Cookie 为 HttpOnly、SameSite=Lax，https 下带 Secure。
- 多用户模式下，所有会改数据的接口都检查 `Origin`，防止跨站请求。
- GitHub 令牌、Webhook 地址用 AES-256-GCM 加密存储，页面上只显示末尾几位或域名。
- 所有数据按用户隔离；多用户模式不会读取服务器上的本地目录。
- 生产环境发送 Content-Security-Policy，页面只加载同源脚本。
- Stripe Webhook 校验签名（5 分钟时间容差），事件按 ID 去重。

## 开发

```bash
npm run check         # lint + 格式检查 + 测试 + 构建，CI 也跑这一套
npm test              # Vitest：用临时 git 仓库、内存 SQLite、假的 GitHub/Stripe 和 Fake 模型，不调用真实 API
npm run build && npm start
```

GitHub Actions（`.github/workflows/ci.yml`）在每次推送和 PR 时运行检查、构建 Docker 镜像，并启动容器验证健康检查。

代码结构：

- `src/shared/`：前后端共享的类型（Zod）和平台规则。
- `src/server/sources/`：本地 git 和 GitHub 采集。
- `src/server/prep/`：过滤与脱敏。
- `src/server/ai/`：模型调用、提示词、理解 / 写作 / 风格学习。
- `src/server/guards/`：事实、引用代码和平台检查。
- `src/server/cards/`：数据卡和代码卡（SVG）。
- `src/server/engagement/`：发布数据、洞察和写作参考。
- `src/server/scheduler/`：每日定时、邮件与 Webhook 提醒。
- `src/server/auth/`、`src/server/billing/`：GitHub 登录、会话、Stripe 订阅。
- `src/server/db/`：SQLite、迁移、加密凭证。
- `src/server/routes/`、`src/server/services/`：接口和业务编排、套餐、时间窗口。
- `src/cli/`：命令行。
- `src/client/`：React 界面。

## 路线图

- 通过 X、Bluesky 的 API 直接发布，并自动回填互动数据
- Telegram 提醒
- 每周回顾：一周的开发与分享汇总成一篇长文
- 团队版：多人仓库的更新日志和周报
