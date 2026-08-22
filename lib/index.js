import { WebError } from '@deepseek-ai/dsh-web';

/**
 * OpenAI-compatible Responses API search provider for the DeepSeek Harness web
 * capability seam (`ctx.web`).
 *
 * Models and credentials are NOT configured here: the provider reads them from
 * the DSH model configuration (`llm-pi-ai.providers` in settings + the
 * credential store behind each provider's `apiKeyEnv`). Only the SELECTION is
 * persisted, in the session workspace `.env` (hot-reloaded on every search):
 *
 *   DSH_SEARCH_MODE=auto            auto chain (GPT-class models first, Grok-class last)
 *   DSH_SEARCH_MODE=manual          only use DSH_SEARCH_MODEL (= "provider::model")
 *   DSH_SEARCH_MODEL=               manual selection
 *   DSH_SEARCH_AUTO_ORDER=          explicit auto chain ("provider::model,..." override)
 *   DSH_SEARCH_XSEARCH=0|1          attach x_search to grok-class models
 *   DSH_SEARCH_FALLBACK_KEY=        manual fallback credentials (only used when the
 *   DSH_SEARCH_FALLBACK_BASE_URL=   selected model cannot be resolved from model config)
 *   DSH_SEARCH_MAX_OUTPUT_TOKENS=   per-answer token cap
 *   DSH_SEARCH_TIMEOUT_MS=          per-attempt timeout
 *
 * The server-side search tool is auto-selected by model name:
 *   contains "grok"                    -> web_search (+ x_search when enabled)
 *   contains "4o"/"4.1"/"preview"      -> web_search_preview
 *   anything else                      -> web_search
 *
 * A 200 answer WITHOUT url_citation/x_handle annotations is treated as
 * "search did not actually run" and the chain falls through to the next model;
 * only when every attempt is citation-free does the best sourceless answer get
 * returned (sources: []).
 */

const PROVIDER_ID = 'openai-responses';
const TOOL_NAME = 'openai_web_search';
const USER_AGENT = 'dsh-web-search-openai/0.2.0';

function parseEnv(text) {
	const out = {};
	for (const rawLine of String(text ?? '').split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
			value = value.slice(1, -1);
		}
		if (key.length > 0) out[key] = value;
	}
	return out;
}

function positiveInt(value, fallback, minimum) {
	const n = parseInt(value, 10);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return n < minimum ? minimum : n;
}

function truthy(value) {
	const s = String(value ?? '').trim().toLowerCase();
	return s === '1' || s === 'true' || s === 'yes';
}

function str(value, fallback) {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function splitList(value) {
	const out = [];
	for (const part of String(value ?? '').split(',')) {
		const m = part.trim();
		if (m.length > 0 && !out.includes(m)) out.push(m);
	}
	return out;
}

function configFromEnv(env) {
	return {
		mode: env.DSH_SEARCH_MODE === 'manual' ? 'manual' : 'auto',
		model: str(env.DSH_SEARCH_MODEL, ''),
		autoOrder: splitList(env.DSH_SEARCH_AUTO_ORDER),
		xsearch: truthy(env.DSH_SEARCH_XSEARCH),
		fallbackKey: str(env.DSH_SEARCH_FALLBACK_KEY, str(env.OPENAI_API_KEY, '')),
		fallbackBaseURL: str(env.DSH_SEARCH_FALLBACK_BASE_URL, str(env.OPENAI_BASE_URL, '')),
		maxOutputTokens: positiveInt(env.DSH_SEARCH_MAX_OUTPUT_TOKENS ?? env.OPENAI_SEARCH_MAX_OUTPUT_TOKENS, 4000, 16),
		timeoutMs: positiveInt(env.DSH_SEARCH_TIMEOUT_MS ?? env.OPENAI_SEARCH_TIMEOUT_MS, 120000, 3000)
	};
}

function isPlaceholder(key) {
	return key.length === 0 || key.includes('REPLACE');
}

function maskKey(key) {
	if (isPlaceholder(key)) return '';
	if (key.length <= 10) return '••••••';
	return `${key.slice(0, 6)}••••••${key.slice(-4)}`;
}

/**
 * Model classes understood by the chain. `null` means "not a search-capable
 * class" (deepseek/glm/kimi/gemma/… are skipped by the auto heuristic).
 */
function searchableClass(modelId) {
	const m = String(modelId).toLowerCase();
	if (m.includes('grok')) return 'grok';
	if (m.includes('gpt') || m.includes('search')) return 'gpt';
	return null;
}

/** Server-tool selection purely by model name. */
function toolsForModel(modelId, xsearch) {
	const m = String(modelId).toLowerCase();
	if (m.includes('grok')) return xsearch ? ['web_search', 'x_search'] : ['web_search'];
	if (m.includes('preview') || m.includes('4o') || m.includes('4.1')) return ['web_search_preview'];
	return ['web_search'];
}

function heuristicOrder(entries) {
	const gpt = [];
	const grok = [];
	for (const e of entries) {
		if (e.modelClass === 'gpt') gpt.push(e.value);
		else if (e.modelClass === 'grok') grok.push(e.value);
	}
	return [...gpt, ...grok];
}

/** Read one model catalog entry's credential through the credentials store. */
async function resolveEntryCredentials(ctx, entry) {
	let apiKey = '';
	if (entry.apiKeyEnv.length > 0) {
		const credentials = ctx.get('credentials');
		if (credentials !== undefined) {
			try {
				const resolved = await credentials.resolve(entry.apiKeyEnv);
				apiKey = typeof resolved?.value === 'string' ? resolved.value : '';
			} catch {
				// treated as unresolved below
			}
		}
	}
	return { baseURL: entry.baseURL, apiKey };
}

/** Combined caller-signal + deadline controller for one native fetch. */
function combinedTimeout(signal, ms) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`timeout after ${ms}ms`)), ms);
	const onAbort = () => controller.abort(signal.reason);
	if (signal !== undefined) {
		if (signal.aborted) onAbort();
		else signal.addEventListener('abort', onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		dispose() {
			clearTimeout(timer);
			if (signal !== undefined) signal.removeEventListener('abort', onAbort);
		}
	};
}

/** One Responses API call. Resolves `{ status, body }`; never throws for HTTP statuses. */
async function postResponses(callCfg, model, tools, query, signal) {
	const endpoint = `${callCfg.baseURL}/responses`;
	const payload = { model, input: query, tools: tools.map((type) => ({ type })) };
	if (callCfg.maxOutputTokens > 0) payload.max_output_tokens = callCfg.maxOutputTokens;

	const timeout = combinedTimeout(signal, callCfg.timeoutMs);
	let response;
	try {
		response = await fetch(endpoint, {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json',
				authorization: `Bearer ${callCfg.apiKey}`,
				'user-agent': USER_AGENT
			},
			body: JSON.stringify(payload),
			signal: timeout.signal
		});
	} catch (error) {
		if (signal?.aborted === true) {
			throw new WebError('OpenAI search aborted', 'WEB_ABORTED', { cause: error });
		}
		throw new WebError(`OpenAI search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
	}

	let body = '';
	try {
		body = await response.text();
	} catch (error) {
		if (signal?.aborted === true) throw new WebError('OpenAI search aborted', 'WEB_ABORTED', { cause: error });
		throw new WebError(`OpenAI search body read failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
	} finally {
		timeout.dispose();
	}
	return { status: response.status, body };
}

/**
 * Extract answer text + citations from a Responses API output array.
 * Never throws; empty sources mean "no citation annotations present".
 */
function mapResponses(body) {
	const output = Array.isArray(body?.output) ? body.output : [];
	const sources = [];
	const seen = new Set();
	let answer = '';
	for (const item of output) {
		if (!item || typeof item !== 'object' || item.type !== 'message') continue;
		const parts = Array.isArray(item.content) ? item.content : [];
		for (const part of parts) {
			if (!part || typeof part !== 'object' || part.type !== 'output_text') continue;
			const text = typeof part.text === 'string' ? part.text : '';
			if (text.length > 0) answer += (answer.length > 0 ? '\n\n' : '') + text;
			const annotations = Array.isArray(part.annotations) ? part.annotations : [];
			for (const ann of annotations) {
				if (!ann || typeof ann !== 'object') continue;
				if (ann.type === 'url_citation') {
					const url = typeof ann.url === 'string' ? ann.url : '';
					if (url.length === 0 || seen.has(url)) continue;
					seen.add(url);
					let snippet = typeof ann.content === 'string' ? ann.content : '';
					if (snippet.length === 0 && typeof ann.start_index === 'number' && typeof ann.end_index === 'number' && text.length > 0) {
						snippet = text.slice(Math.max(0, ann.start_index), Math.min(text.length, ann.end_index));
					}
					const source = { url };
					if (typeof ann.title === 'string' && ann.title.length > 0) source.title = ann.title;
					if (snippet.length > 0) source.snippet = snippet;
					sources.push(source);
				} else if (ann.type === 'x_handle' && typeof ann.handle === 'string' && ann.handle.length > 0) {
					const handle = ann.handle.replace(/^@/, '');
					const url = `https://x.com/${handle}`;
					if (seen.has(url)) continue;
					seen.add(url);
					sources.push({ url, title: `@${handle}` });
				}
			}
		}
	}
	return { sources, content: answer };
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-openai';

/** The seams this plugin consumes. */
export const inject = ['web', 'fs', 'settings', 'credentials', 'tools'];

/** Register the OpenAI-compatible search provider and the direct model tool. */
export function apply(ctx) {
	async function readEnvText() {
		try {
			return await ctx.fs.readText(await ctx.fs.resolve('.env'));
		} catch {
			return '';
		}
	}

	let cache = { text: null, cfg: null };
	async function currentConfig() {
		const text = await readEnvText();
		if (cache.cfg === null || text !== cache.text) {
			cache = { text, cfg: configFromEnv(parseEnv(text)) };
		}
		return cache.cfg;
	}
	currentConfig().catch(() => {});

	async function loadCatalog() {
		const entries = [];
		let defaultModel = '';
		const settings = ctx.get('settings');
		if (settings !== undefined) {
			let providers = null;
			try {
				const section = settings.get('llm-pi-ai');
				if (section && typeof section === 'object' && section.providers && typeof section.providers === 'object') providers = section.providers;
			} catch {
				providers = null;
			}
			try {
				const d = settings.get('agent-default-model');
				if (d && typeof d === 'object' && typeof d.provider === 'string' && typeof d.model === 'string') defaultModel = `${d.provider}::${d.model}`;
			} catch {
				defaultModel = '';
			}
			if (providers) {
				for (const pname of Object.keys(providers)) {
					const p = providers[pname];
					if (!p || typeof p !== 'object') continue;
					const baseURL = typeof p.baseURL === 'string' ? p.baseURL.replace(/\/+$/, '') : '';
					const apiKeyEnv = typeof p.apiKeyEnv === 'string' ? p.apiKeyEnv : '';
					const models = Array.isArray(p.models) ? p.models : [];
					for (const m of models) {
						if (!m || typeof m !== 'object' || typeof m.id !== 'string' || m.id.length === 0) continue;
						entries.push({
							value: `${pname}::${m.id}`,
							provider: pname,
							model: m.id,
							label: `${pname} ▸ ${typeof m.name === 'string' && m.name.length > 0 ? m.name : m.id}`,
							baseURL,
							apiKeyEnv,
							modelClass: searchableClass(m.id)
						});
					}
				}
			}
		}
		const map = {};
		for (const e of entries) map[e.value] = e;
		return { entries, map, defaultModel };
	}

	async function runSearch(query, signal) {
		const cfg = await currentConfig();
		const catalog = await loadCatalog();

		let chain;
		if (cfg.mode === 'manual') chain = cfg.model.length > 0 ? [cfg.model] : [];
		else if (cfg.autoOrder.length > 0) chain = [...cfg.autoOrder];
		else chain = heuristicOrder(catalog.entries);
		if (chain.length === 0) {
			throw new WebError('[openai-search] 没有可尝试的模型：DSH 模型配置为空，或未设置 DSH_SEARCH_MODEL（manual 模式）', 'WEB_PROVIDER_UNAVAILABLE');
		}

		const failures = [];
		let sourceless = null;

		for (const value of chain) {
			if (signal?.aborted === true) throw new WebError('OpenAI search aborted', 'WEB_ABORTED');

			const entry = catalog.map[value] ?? null;
			const modelName = entry ? entry.model : value.split('::').pop();
			let baseURL = entry ? entry.baseURL : '';
			let apiKey = '';
			if (entry) {
				const r = await resolveEntryCredentials(ctx, entry);
				baseURL = r.baseURL;
				apiKey = r.apiKey;
			}
			if ((apiKey.length === 0 || baseURL.length === 0) && !isPlaceholder(cfg.fallbackKey) && cfg.fallbackBaseURL.length > 0) {
				if (apiKey.length === 0) apiKey = cfg.fallbackKey;
				if (baseURL.length === 0) baseURL = cfg.fallbackBaseURL;
			}
			if (baseURL.length === 0 || isPlaceholder(apiKey)) {
				failures.push(`${value} -> 未解析到可用的 baseURL/key（模型配置缺凭据，且未配置手动兜底）`);
				continue;
			}

			const callCfg = { baseURL, apiKey, maxOutputTokens: cfg.maxOutputTokens, timeoutMs: cfg.timeoutMs };
			const combos = [];
			const primary = toolsForModel(modelName, cfg.xsearch);
			combos.push(primary);
			if (primary[0] !== 'web_search') combos.push(['web_search']);
			if (primary.includes('x_search')) combos.push(['web_search']);

			for (const tools of combos) {
				const label = `${value}[${tools.join('+')}]`;
				if (signal?.aborted === true) throw new WebError('OpenAI search aborted', 'WEB_ABORTED');

				let reply;
				try {
					reply = await postResponses(callCfg, modelName, tools, query, signal);
				} catch (error) {
					if (error instanceof WebError) throw error;
					failures.push(`${label} -> ${String(error?.message ?? error)}`);
					continue;
				}
				if (reply.status === 401 || reply.status === 403) {
					throw new WebError(`[openai-search] credential rejected (HTTP ${reply.status}) by ${baseURL}: ${reply.body.slice(0, 240)}`, 'WEB_PROVIDER_CREDENTIAL_MISSING');
				}
				if (reply.status === 429) {
					throw new WebError(`[openai-search] rate limited (HTTP 429): ${label}`, 'WEB_PROVIDER_ERROR');
				}
				if (reply.status >= 200 && reply.status < 300) {
					let parsed;
					try {
						parsed = JSON.parse(reply.body);
					} catch {
						failures.push(`${label} -> HTTP 200 非 JSON 响应`);
						continue;
					}
					const mapped = mapResponses(parsed);
					if (mapped.sources.length > 0) {
						const result = { sources: mapped.sources, truncated: false };
						if (mapped.content.length > 0) result.content = mapped.content;
						return result;
					}
					if (mapped.content.length > 0 && sourceless === null) {
						sourceless = { content: mapped.content, via: label };
					}
					failures.push(`${label} -> HTTP 200 但没有任何搜索引用（中转/模型疑似未真正执行 web_search）`);
					continue;
				}
				failures.push(`HTTP ${reply.status} (${label}): ${reply.body.slice(0, 200)}`);
			}
		}

		if (sourceless !== null) {
			console.log(`[dsh-web-search-openai] 所有档位均无引用，回退返回无引用回答（来自 ${sourceless.via}）`);
			return { content: sourceless.content, sources: [], truncated: false };
		}
		throw new WebError(`[openai-search] 所有模型/工具组合均失败:\n${failures.join('\n')}`, 'WEB_PROVIDER_ERROR');
	}

	ctx.web.registerSearchProvider({
		id: PROVIDER_ID,
		available() {
			return true;
		},
		search(request, signal) {
			return runSearch(String(request.query), signal);
		}
	});

	ctx.tools.register({
		name: TOOL_NAME,
		description: 'Search the web via DSH-configured OpenAI-compatible Responses API providers. Models and credentials come from the DSH model configuration; tool type is auto-selected by model name (grok -> web_search [+x_search], 4o/4.1/preview -> web_search_preview, others -> web_search). A 200 answer WITHOUT citations is treated as not-searched and the chain falls through to the next model.',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'The web search query.' },
				max_results: { type: 'integer', description: 'Optional upper bound on returned sources.' }
			},
			required: ['query']
		},
		execute: async (args, exec) => {
			const query = typeof args?.query === 'string' ? args.query : '';
			if (query.trim().length === 0) throw new Error('query must be a non-empty string');
			const result = await runSearch(query, exec?.signal);
			const limit = Number.isInteger(args?.max_results) && args.max_results > 0 ? args.max_results : undefined;
			const sources = limit !== undefined ? result.sources.slice(0, limit) : [...result.sources];
			return {
				query,
				content: typeof result.content === 'string' ? result.content.slice(0, 6000) : '',
				sources,
				sourceCount: sources.length,
				searched: sources.length > 0
			};
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render(_args, value) {
				return [{ type: 'text', text: JSON.stringify(value) }];
			}
		},
		timeoutMs: 180000,
		isConcurrencySafe: () => true
	});

	console.log('[dsh-web-search-openai] registered: ctx.web provider "openai-responses" + tool "openai_web_search".');
}
