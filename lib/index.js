import { readFileSync } from 'node:fs';
import { WebError } from '@deepseek-ai/dsh-web';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';

/**
 * Unified web search aggregator for the DeepSeek Harness web capability seam
 * (`ctx.web`). Two backends, one provider, configurable chain order:
 *
 *   parallel — keyless Parallel Web Search MCP (https://search.parallel.ai/mcp)
 *   openai   — OpenAI-compatible Responses API relays read from the DSH model
 *              configuration (`llm-pi-ai.providers` + credential store); the
 *              server tool is auto-selected by model name and a 200 answer
 *              WITHOUT citations falls through to the next model.
 *
 * Selection persistence precedence: settings section saved fields > session
 * workspace .env (hot-reloaded every search) > built-in defaults.
 *
 * .env vocabulary (mirrored by the settings section):
 *
 *   DSH_SEARCH_CHAIN=parallel,openai  backend order
 *   DSH_SEARCH_MODE=auto|manual       openai backend: auto chain vs single model
 *   DSH_SEARCH_MODEL=                 manual selection ("provider::model")
 *   DSH_SEARCH_AUTO_ORDER=            auto chain override ("provider::model,...")
 *   DSH_SEARCH_XSEARCH=0|1            attach x_search to grok-class models
 *   DSH_SEARCH_FALLBACK_KEY=          manual fallback credentials for openai backend
 *   DSH_SEARCH_FALLBACK_BASE_URL=
 *   DSH_SEARCH_MAX_OUTPUT_TOKENS=
 *   DSH_SEARCH_TIMEOUT_MS=
 */

export const WEB_SEARCH_OPENAI_SETTINGS_NAMESPACE = settingsNamespace('web-search-openai');

/** Settings section schema — mirrors the .env vocabulary, no implicit defaults. */
export const SettingsSchema = z.object({
	chain: z.string().description('backend order, comma list: parallel,openai'),
	mode: z.string().description('openai backend: auto | manual'),
	model: z.string().description('manual-mode selection, "provider::model"'),
	autoOrder: z.string().description('comma list of "provider::model" overriding the openai auto chain'),
	xsearch: z.boolean().description('attach x_search to grok-class models'),
	fallbackApiKey: z.string().role('secret').description('fallback key when model-config resolution fails'),
	fallbackBaseURL: z.string().description('fallback base URL paired with the fallback key'),
	maxOutputTokens: z.number().step(1).min(16).description('per-answer output token cap'),
	timeoutMs: z.number().step(1).min(3000).description('per-attempt timeout in milliseconds')
});

const PROVIDER_ID = 'openai-responses';
const TOOL_NAME = 'openai_web_search';
const USER_AGENT = 'dsh-web-search-openai/0.5.1';

// ---------------- shared small utils ----------------

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

function isPlaceholder(key) {
	return key.length === 0 || key.includes('REPLACE');
}

function randomHex(length) {
	let s = '';
	for (let i = 0; i < length; i++) s += Math.floor(Math.random() * 16).toString(16);
	return s;
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

function configFromEnv(env) {
	return {
		chain: splitList(str(env.DSH_SEARCH_CHAIN, 'parallel,openai')),
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

/** Best-effort synchronous seed so a fresh install shows the workspace .env choices. */
function seedSectionFromWorkspaceEnv() {
	try {
		return configFromEnv(parseEnv(readFileSync('.env', 'utf8')));
	} catch {
		return null;
	}
}

function sectionToConfig(section, envFallback) {
	const s = section && typeof section === 'object' ? section : {};
	const chainRaw = splitList(str(s.chain, envFallback.chain.join(','))).filter((b) => b === 'parallel' || b === 'openai');
	return {
		chain: chainRaw.length > 0 ? chainRaw : ['parallel', 'openai'],
		mode: str(s.mode, envFallback.mode) === 'manual' ? 'manual' : 'auto',
		model: str(s.model, envFallback.model),
		autoOrder: splitList(str(s.autoOrder, envFallback.autoOrder.join(','))),
		xsearch: typeof s.xsearch === 'boolean' ? s.xsearch : envFallback.xsearch,
		fallbackKey: str(s.fallbackApiKey, envFallback.fallbackKey),
		fallbackBaseURL: str(s.fallbackBaseURL, envFallback.fallbackBaseURL),
		maxOutputTokens: positiveInt(s.maxOutputTokens, envFallback.maxOutputTokens, 16),
		timeoutMs: positiveInt(s.timeoutMs, envFallback.timeoutMs, 3000)
	};
}

// ---------------- backend: parallel (MCP streamable HTTP, keyless) ----------------

const PARALLEL_ENDPOINT = 'https://search.parallel.ai/mcp';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const MCP_CLIENT_NAME = 'dsh-web-search-openai';
const SNIPPET_MAX_CHARS = 1500;

function extractSseData(text) {
	if (!text.startsWith('event:') && !text.startsWith('data:') && !text.includes('\ndata:')) return null;
	const lines = String(text).split(/\r?\n/).filter((l) => l.startsWith('data:'));
	return lines.length > 0 ? lines[lines.length - 1].slice(5).trim() : null;
}

async function postRpc(endpoint, sessionId, body, signal) {
	const headers = {
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
		'mcp-protocol-version': MCP_PROTOCOL_VERSION,
		'user-agent': USER_AGENT
	};
	if (sessionId !== undefined && sessionId !== null) headers['mcp-session-id'] = sessionId;
	const response = await fetch(endpoint, {
		method: 'POST',
		redirect: 'error',
		headers,
		body: JSON.stringify(body),
		...(signal !== undefined ? { signal } : {})
	});
	const raw = await response.text();
	if (!response.ok) throw new WebError(`Parallel MCP HTTP ${response.status}: ${raw.slice(0, 200)}`, 'WEB_PROVIDER_ERROR');
	const dataLine = extractSseData(raw);
	const payloadText = dataLine !== null && dataLine.length > 0 ? dataLine : raw;
	if (payloadText.trim().length === 0) return { headers: response.headers, json: null };
	let json;
	try {
		json = JSON.parse(payloadText);
	} catch (error) {
		throw new WebError(`Parallel MCP unparseable response: ${payloadText.slice(0, 200)}`, 'WEB_PROVIDER_ERROR', { cause: error });
	}
	return { headers: response.headers, json };
}

async function mcpParallelSearch(query, searchSessionId, timeoutMs, signal) {
	const timeout = combinedTimeout(signal, timeoutMs);
	try {
		const init = await postRpc(
			PARALLEL_ENDPOINT,
			undefined,
			{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: MCP_CLIENT_NAME, version: '0.5.0' } } },
			timeout.signal
		);
		const sessionId = init.headers !== undefined ? init.headers.get('mcp-session-id') : null;
		await postRpc(PARALLEL_ENDPOINT, sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' }, timeout.signal);
		const call = await postRpc(
			PARALLEL_ENDPOINT,
			sessionId,
			{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'web_search', arguments: { objective: query, search_queries: [query], session_id: searchSessionId } } },
			timeout.signal
		);
		if (call.json === null) throw new WebError('Parallel MCP empty tools/call response', 'WEB_PROVIDER_ERROR');
		if (call.json.error) throw new WebError(`Parallel MCP error ${call.json.error.code}: ${String(call.json.error.message ?? '').slice(0, 200)}`, 'WEB_PROVIDER_ERROR');
		const result = call.json.result;
		if (!result || result.isError === true) throw new WebError(`Parallel MCP tool failed: ${JSON.stringify(result ?? {}).slice(0, 300)}`, 'WEB_PROVIDER_ERROR');
		const textBlock = Array.isArray(result.content) ? result.content.find((c) => c && c.type === 'text') : null;
		let parsed = {};
		try {
			parsed = JSON.parse(textBlock && typeof textBlock.text === 'string' ? textBlock.text : '{}');
		} catch (error) {
			throw new WebError(`Parallel MCP non-JSON payload: ${String(textBlock?.text ?? '').slice(0, 200)}`, 'WEB_PROVIDER_ERROR', { cause: error });
		}
		const rows = Array.isArray(parsed.results) ? parsed.results : [];
		const sources = [];
		for (const r of rows) {
			if (!r || typeof r.url !== 'string' || r.url.length === 0) continue;
			const source = { url: r.url };
			if (typeof r.title === 'string' && r.title.length > 0) source.title = r.title;
			if (Array.isArray(r.excerpts) && r.excerpts.length > 0) {
				let snippet = r.excerpts.filter((x) => typeof x === 'string').join('\n\n');
				if (snippet.length > SNIPPET_MAX_CHARS) snippet = snippet.slice(0, SNIPPET_MAX_CHARS);
				if (snippet.length > 0) source.snippet = snippet;
			}
			if (typeof r.publish_date === 'string' && r.publish_date.length > 0) source.publishedAt = r.publish_date;
			sources.push(source);
		}
		return { sources };
	} finally {
		timeout.dispose();
	}
}

// ---------------- backend: openai (Responses API over model config) ----------------

function searchableClass(modelId) {
	const m = String(modelId).toLowerCase();
	if (m.includes('grok')) return 'grok';
	if (m.includes('gpt') || m.includes('search')) return 'gpt';
	return null;
}

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

async function postResponses(callCfg, model, tools, query, signal) {
	const endpoint = `${callCfg.baseURL}/responses`;
	const payload = { model, input: query, tools: tools.map((type) => ({ type })), store: false };
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
		if (signal?.aborted === true) throw new WebError('OpenAI search aborted', 'WEB_ABORTED', { cause: error });
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

/**
 * Register the unified search provider (configurable parallel/openai chain)
 * and the direct model tool.
 * @param ctx - the mounting context.
 * @param config - optional cordis.yml row config seeding the settings section.
 */
export function apply(ctx, config = {}) {
	async function readEnvText() {
		try {
			return await ctx.fs.readText(await ctx.fs.resolve('.env'));
		} catch {
			return '';
		}
	}

	let cache = { text: null, cfg: null };
	async function currentEnvConfig() {
		const text = await readEnvText();
		if (cache.cfg === null || text !== cache.text) {
			cache = { text, cfg: configFromEnv(parseEnv(text)) };
		}
		return cache.cfg;
	}
	currentEnvConfig().catch(() => {});

	let currentSection = () => config;
	installSettingsSection(ctx, WEB_SEARCH_OPENAI_SETTINGS_NAMESPACE, SettingsSchema, seedSectionFromWorkspaceEnv() ?? config, {
		validate(value) {
			if (value.timeoutMs != null && (value.timeoutMs < 1000 || value.timeoutMs > 300000)) throw new Error('timeoutMs 需在 1000–300000 之间');
			if (value.maxOutputTokens != null && (value.maxOutputTokens < 16 || value.maxOutputTokens > 64000)) throw new Error('maxOutputTokens 需在 16–64000 之间');
			for (const b of splitList(value.chain)) {
				if (b !== 'parallel' && b !== 'openai') throw new Error(`未知引擎: ${b}（仅支持 parallel/openai）`);
			}
		},
		setSource: (source) => {
			currentSection = source;
		},
		onChange: () => {}
	});

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

	async function runOpenaiBackend(cfg, query, signal, failures, state) {
		const catalog = await loadCatalog();
		let chain;
		if (cfg.mode === 'manual') chain = cfg.model.length > 0 ? [cfg.model] : [];
		else if (cfg.autoOrder.length > 0) chain = [...cfg.autoOrder];
		else chain = heuristicOrder(catalog.entries);
		if (chain.length === 0) {
			failures.push('openai -> 模型配置为空或未选择手动模型');
			return;
		}
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
					if (error instanceof WebError && error.code === 'WEB_ABORTED') throw error;
					failures.push(`${label} -> ${String(error?.message ?? error)}`);
					continue;
				}
				if (reply.status === 401 || reply.status === 403) {
					failures.push(`${label} -> credential rejected (HTTP ${reply.status}): ${reply.body.slice(0, 160)}`);
					continue;
				}
				if (reply.status === 429) {
					failures.push(`${label} -> HTTP 429 rate limited`);
					continue;
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
						state.resolved = result;
						return;
					}
					if (mapped.content.length > 0 && state.sourceless === null) {
						state.sourceless = { content: mapped.content, via: label };
					}
					failures.push(`${label} -> HTTP 200 但没有任何搜索引用`);
					continue;
				}
				failures.push(`HTTP ${reply.status} (${label}): ${reply.body.slice(0, 200)}`);
			}
		}
	}

	async function runSearch(query, signal, maxResults) {
		const envCfg = await currentEnvConfig();
		const cfg = sectionToConfig(currentSection(), envCfg);
		const failures = [];
		const state = { sourceless: null, resolved: null };

		function emit(result) {
			if (!maxResults || result.sources.length <= maxResults) return { ...result, truncated: false };
			return { ...result, sources: result.sources.slice(0, maxResults), truncated: true };
		}

		for (const backend of cfg.chain) {
			if (signal?.aborted === true) throw new WebError('search aborted', 'WEB_ABORTED');
			if (backend === 'parallel') {
				try {
					const mapped = await mcpParallelSearch(query, parallelSessionId, Math.min(cfg.timeoutMs, 60000), signal);
					if (mapped.sources.length > 0) return { sources: mapped.sources, truncated: false };
					failures.push('parallel -> 无结果');
				} catch (error) {
					if (error instanceof WebError && error.code === 'WEB_ABORTED') throw error;
					failures.push(`parallel -> ${String(error?.message ?? error).slice(0, 240)}`);
				}
			} else if (backend === 'openai') {
				await runOpenaiBackend(cfg, query, signal, failures, state);
				if (state.resolved !== null) return state.resolved;
			} else {
				failures.push(`${backend} -> 未知引擎（仅支持 parallel/openai）`);
			}
		}

		if (state.sourceless !== null) {
			console.log(`[dsh-web-search-openai] 所有档位均无引用，回退返回无引用回答（来自 ${state.sourceless.via}）`);
			return { content: state.sourceless.content, sources: [], truncated: false };
		}
		throw new WebError(`[openai-search] 所有后端均失败:\n${failures.join('\n')}`, 'WEB_PROVIDER_ERROR');
	}

	const parallelSessionId = randomHex(32);

	const disposeProvider = ctx.web.registerSearchProvider({
		id: PROVIDER_ID,
		available() {
			return cache.cfg !== null && cache.cfg.chain.length > 0;
		},
		search(request, signal) {
			const rawLimit = request?.maxResults ?? request?.max_results;
			const maxResults = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
			return runSearch(String(request?.query ?? ''), signal, maxResults);
		}
	});
	ctx.effect(disposeProvider, 'web-search-openai: provider');

	const disposeTool = ctx.tools.register({
		name: TOOL_NAME,
		description: 'Unified web search with configurable backend order (default: Parallel MCP first, then OpenAI-compatible Responses API relays resolved from the DSH model configuration). Only citation-backed results are accepted when available; empty or uncited answers fall through to the next backend/model.',
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
	ctx.effect(disposeTool, 'web-search-openai: tool');

	console.log('[dsh-web-search-openai] v0.5.0 registered: unified provider (chain default parallel->openai) + tool.');
}
