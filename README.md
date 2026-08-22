# dsh-web-search-openai

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

DeepSeek Harness (DSH) 的 **OpenAI 兼容 Responses API 网页搜索插件**，注册到 `ctx.web`（搜索能力接缝），仿照官方 [`@deepseek-ai/dsh-web-search-deepseek`](https://www.npmjs.com/package/@deepseek-ai/dsh-web-search-deepseek) 的形态实现。

**核心理念：模型、Base URL、API Key 全部读取自 DSH 已有的模型配置，零重复输入。**

- 模型目录：`~/.dsh/settings.yaml` 的 `llm-pi-ai.providers`（各 provider 的 `baseURL` + `apiKeyEnv` + `models[]`）
- 凭据：每个 provider 的 `apiKeyEnv` 对应 `~/.dsh/.credentials.yaml` 中的条目（经 DSH credentials 服务解析）
- 本插件只持久化"选择"，配置写在会话工作区 `.env`，每次搜索实时重读，改完即生效

## 工作方式

### 1. 服务端搜索工具按模型名自动匹配

| 模型名包含 | 自动挂载的服务端工具 |
| --- | --- |
| `grok` | `web_search`（可加挂 `x_search`，搜 X/Twitter，支持解析 `x_handle` 引用） |
| `4o` / `4.1` / `preview` | `web_search_preview` |
| 其他（gpt-5.x 等） | `web_search` |

### 2. 自动 / 手动两种模式

- **auto（默认）**：GPT 类模型按模型配置顺序先试，Grok 类收尾；顺序可用 `DSH_SEARCH_AUTO_ORDER` 覆盖
- **manual**：只用 `DSH_SEARCH_MODEL=provider::模型` 指定的单一模型

### 3. 无引用即降级

某档返回 200 但**没有任何 `url_citation` / `x_handle` 引用**时，视为该中转/模型未真正执行服务端搜索，自动降级下一档；全部降级完仍无引用，才回退返回无引用回答（`sources: []`，工具输出带 `searched: false`）。401/403/429 鉴权限流类错误快速失败不空转。

## 安装

```sh
# 方式一：dsh 插件命令（本地目录）
dsh plugin --profile <你的profile> add ./dsh-web-search-openai

# 方式二：npm 打包后安装
npm pack            # 生成 dsh-web-search-openai-0.2.0.tgz
dsh plugin --profile <你的profile> add ./dsh-web-search-openai-0.2.0.tgz
```

或在部署的 `cordis.yml` 中手动加一行（以实际 loader 语法为准）：

```yaml
- id: web-search-openai
  name: dsh-web-search-openai
```

安装后重启对应 Profile / 进程生效。

## 配置（会话工作区 `.env`）

```ini
DSH_SEARCH_MODE=auto                    # auto | manual
DSH_SEARCH_MODEL=                       # manual 模式：input::grok-4.6 这样的 provider::模型
DSH_SEARCH_AUTO_ORDER=                  # auto 链覆盖：provider::模型1,provider::模型2,...
DSH_SEARCH_XSEARCH=0                    # 1 = 对 grok 类加挂 x_search
DSH_SEARCH_FALLBACK_KEY=                # 手动兜底 Key（仅当选中模型在模型配置中解析不到凭据时用）
DSH_SEARCH_FALLBACK_BASE_URL=
DSH_SEARCH_MAX_OUTPUT_TOKENS=4000
DSH_SEARCH_TIMEOUT_MS=120000
```

> 前提：所选模型走的中转必须**真·OpenAI 透传**（原样转发 `/responses` 且保留内建 server tool）。若中转剥掉 `tools` 字段，所有档位都会得到"200 但无引用"的回答——本插件会诚实地把它标记为未搜索而不是假装成功。

## 使用

注册后即可通过两条路径使用：

1. **Agent 工具**：`openai_web_search`（参数 `query`、可选 `max_results`）
2. **Web 接缝**：`ctx.web.search()` 在 provider 选择命中 `openai-responses` 时走本插件

## License

MIT
