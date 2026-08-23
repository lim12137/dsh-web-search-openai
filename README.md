# dsh-web-search-openai

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.5.2-green.svg)](./package.json)

DeepSeek Harness (DSH) 的**统一网页搜索聚合插件**：把免 Key 的 [Parallel Search MCP](https://search.parallel.ai/mcp) 与 OpenAI 兼容 **Responses API 中转**（内建 `web_search` 服务端工具）串成一条可配置的降级链，注册到 `ctx.web` 搜索接缝，并自带设置页卡片。

仿照官方 [`@deepseek-ai/dsh-web-search-deepseek`](https://www.npmjs.com/package/@deepseek-ai/dsh-web-search-deepseek) 的形态实现。

**核心理念：模型、Base URL、API Key 全部读取自 DSH 已有的模型配置，零重复输入；插件只持久化"选择"。**

## 特性

- **链式后端**：`WEB_SEARCH_CHAIN=parallel,openai`（默认），任一档成功即返回，失败/无引用自动落下一档
- **Parallel 档**：MCP streamable HTTP（initialize → tools/call `web_search`），无需任何 Key
- **OpenAI 档**：模型目录读自 `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers`，凭据经 credentials 服务解析 `apiKeyEnv`
- **工具按模型名匹配**：`grok` → `web_search`(+`x_search`)；`4o/4.1/preview` → `web_search_preview`；其余 → `web_search`
- **无引用即降级**：200 但零 `url_citation` 视为未真搜，换下一档；全部失败才回退无引用回答（`searched: false`）
- **思考强度可调**：`WEB_SEARCH_REASONING=auto|minimal|low|medium|high`（实测搜索任务 `minimal` 比 `auto` 快 ~32% 且引用不降）
- **错误纪律**：三态错误码（`WEB_ABORTED` / `WEB_PROVIDER_CREDENTIAL_MISSING` / `WEB_PROVIDER_ERROR`）、取消传播整条链、`redirect:'error'` 防 Bearer 泄漏、`store:false` 不留服务端副本、结果去重 + `maxResults` 截断

## 真实测试数据（2026-08-22，中转 ai.input.im）

| 档位 | 结果 | 耗时 |
| --- | --- | --- |
| Parallel MCP | ✅ 10 条来源 | 3–5 s |
| gpt-5.6-luna + web_search | ✅ 带引用回答 | 12.5–22 s |
| 同上 + `reasoning:minimal` | ✅ 引用数不变 | **12.5 s** |
| gpt-5.4-mini | ⚠️ 200 但零引用 → 链内自动降级 | ~9–20 s |

> 前提：所选模型走的中转必须**真·OpenAI 透传**（原样转发 `/responses` 且保留内建 server tool）。若中转剥掉 `tools` 字段，所有档位都会得到"200 但无引用"的回答——本插件会诚实地把它标记为未搜索而不是假装成功。

## 安装

```sh
dsh plugin --profile <你的profile> add <本目录路径>
# 或 npm pack 后 add 生成的 tgz
```

安装即以 bundle patch 形式生效（本包自带 `cordis.patch.yml`：插入自身行、把 `web.searchProvider` 切到 `openai-responses`、停用官方 deepseek 行）。安装后重启对应 Profile。

### `link:` 开发安装的裸导入解析要求

本插件 `lib/index.js` 裸导入 `@deepseek-ai/dsh-web`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/schemastery`。pnpm `link:` 安装时 Node 会把 junction 解析回本目录真实路径再解析 import，**宿主包必须在插件目录内可达**，否则 dsh 启动即崩（`ERR_MODULE_NOT_FOUND`，详见排障总结第十一条铁律）。运行仓库根目录的 `link-host-deps.cmd` 一键补齐三个 junction：

```bat
link-host-deps.cmd                                  &rem 默认指向 DshTray 自包含运行时
link-host-deps.cmd "C:\...\node_modules\@deepseek-ai\dsh\node_modules"   &rem 或系统 dsh 的嵌套 node_modules
```

运行时目录移动/重装后需重跑（junction 为绝对路径）。

### 写 patch 的铁律（踩坑实录）

- bundle 列表里的包会贡献自己的 `cordis.patch.yml` 作为一层；**只能 insert 没有任何更早层创建过的 id**——重复插入既有 id（如 dsh-base 已插入的 `web`）会让整个 profile 启动崩溃：`duplicate loader entry id: web`
- 裸行 `- id: x / config:` 是**整行 config 替换**语义，必须重申该行拥有的全部键
- `link:` 依赖在 `profiles/*/node_modules/` 下可能是物理拷贝——改完源码记得两处同步（或用 `pnpm install` 让它变成 junction）

## 配置（会话工作区 `.env`，每次搜索实时重读）

```ini
WEB_SEARCH_CHAIN=parallel,openai         # 引擎顺序
WEB_SEARCH_MODE=auto                     # auto | manual
WEB_SEARCH_MODEL=                        # manual：input::gpt-5.6-luna 这样的 provider::模型
WEB_SEARCH_AUTO_ORDER=                   # auto 链覆盖：provider::模型1,provider::模型2,...
WEB_SEARCH_XSEARCH=0                     # 1 = 对 grok 类加挂 x_search
WEB_SEARCH_REASONING=low                 # auto(不传)|minimal|low|medium|high
WEB_SEARCH_FALLBACK_KEY=                 # 兜底 Key（仅当选中模型解析不到凭据时用）
WEB_SEARCH_FALLBACK_BASE_URL=
WEB_SEARCH_MAX_OUTPUT_TOKENS=4000
WEB_SEARCH_TIMEOUT_MS=120000
```

> ⚠️ **变量名禁止用 `DSH_` 前缀**：harness 启动守卫会把启动目录与 `$DSH_HOME` 下 `.env` 里的任何 `DSH_*` 变量视为"仅启动环境可设"，直接拒绝启动（`only the launching environment may set`）。旧版 `DSH_SEARCH_*` 名仍可作为**导出的真实环境变量**被兼容读取。

## 设置面板

静态安装后，DSH 设置 → 插件出现 **「web-search-openai」** 卡片，字段与 `.env` 一一对应：引擎顺序 / 模式 / 手动模型 / 自动链顺序 / 思考强度 / x_search 开关 / 兜底 Key 与 Base URL / 输出上限 / 超时。

优先级：**设置面板保存过的值 > 工作区 `.env` > 内置默认**。首次安装时卡片自动预填工作区 `.env` 当前值；未保存的字段继续跟随 `.env` 热更新。

## 使用

1. **Agent 工具**：`openai_web_search`（参数 `query`、可选 `max_results`）
2. **Web 接缝**：`ctx.web.search()` 在 provider 命中 `openai-responses` 时走本插件

## License

MIT
