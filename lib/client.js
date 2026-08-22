window.__ModuleLoader__.load({
	id: "dsh-web-search-openai",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const NAMESPACE = "web-search-openai";
		const MODELS_NAMESPACE = "llm-pi-ai";

		const CHAIN_PRESETS = [
			{ value: "parallel,openai", label: "Parallel → 中转模型（推荐）" },
			{ value: "openai,parallel", label: "中转模型 → Parallel" },
			{ value: "parallel", label: "仅 Parallel（免 Key）" },
			{ value: "openai", label: "仅中转模型" }
		];
		const REASONING_OPTIONS = [
			{ value: "auto", label: "跟随上游（不传）" },
			{ value: "minimal", label: "minimal — 最快" },
			{ value: "low", label: "low — 稳妥（推荐）" },
			{ value: "medium", label: "medium" },
			{ value: "high", label: "high — 最慢最贵" }
		];
		const NUMBER_FIELDS = [
			{ key: "maxOutputTokens", label: "输出 token 上限", hint: "单次回答的输出预算" },
			{ key: "timeoutMs", label: "单次尝试超时（毫秒）", hint: "超时即判失败并降级" }
		];

		function searchableId(id) {
			const m = String(id ?? "").toLowerCase();
			return m.includes("grok") || m.includes("gpt") || m.includes("search");
		}

		/** Flatten the llm-pi-ai catalog into searchable provider::model entries. */
		function readCatalog(value) {
			const out = [];
			const providers = value && typeof value === "object" && value.providers ? value.providers : {};
			for (const pname of Object.keys(providers)) {
				const p = providers[pname];
				if (!p || typeof p !== "object") continue;
				const models = Array.isArray(p.models) ? p.models : [];
				for (const m of models) {
					if (!m || typeof m !== "object" || typeof m.id !== "string") continue;
					if (!searchableId(m.id)) continue;
					out.push({ value: pname + "::" + m.id, label: pname + " ▸ " + m.id });
				}
			}
			return out;
		}

		function parseList(text) {
			return String(text ?? "").split(",").map((x) => x.trim()).filter((x) => x.length > 0);
		}

		const inputStyle = {
			border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
			background: "var(--dsw-alias-bg-layer-3, rgba(127,127,127,.08))",
			color: "inherit",
			borderRadius: "8px",
			padding: "6px 10px",
			fontSize: "13px",
			fontFamily: "inherit",
			outline: "none",
			width: "100%",
			boxSizing: "border-box"
		};
		const chipStyle = {
			border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
			borderRadius: "999px",
			padding: "2px 10px",
			fontSize: "12px",
			display: "inline-flex",
			alignItems: "center"
		};
		const smallBtn = {
			cursor: "pointer",
			fontSize: "12px",
			lineHeight: "1",
			padding: "4px 8px",
			borderRadius: "6px",
			border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
			background: "transparent",
			color: "inherit"
		};

		/** One labeled control row; set props.noRule to drop the separator line. */
		function Field(props) {
			return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "4px", padding: "9px 0", borderTop: props.noRule ? "none" : "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18))" } },
				react.createElement("label", { style: { fontSize: "13px", fontWeight: 500, opacity: 0.85 } }, props.label),
				props.hint ? react.createElement("div", { style: { fontSize: "12px", opacity: 0.55, marginTop: "-2px" } }, props.hint) : null,
				props.children
			);
		}

		/** Titled group with an accent tick, visually separating card sections. */
		function Section(props) {
			return react.createElement("div", { style: { padding: "12px 0 2px" } },
				react.createElement("div", { style: { display: "flex", alignItems: "center", gap: "8px", paddingBottom: "4px" } },
					react.createElement("span", { style: { width: "3px", height: "12px", borderRadius: "2px", background: "var(--dsw-alias-brand-primary, #2f6feb)", opacity: 0.85, display: "inline-block" } }),
					react.createElement("span", { style: { fontSize: "12px", fontWeight: 600, letterSpacing: "0.03em", opacity: 0.75 } }, props.title),
					props.right ? react.createElement("span", { style: { marginLeft: "auto" } }, props.right) : null
				),
				props.children
			);
		}

		function Select(props) {
			return react.createElement("select", {
				style: Object.assign({}, inputStyle),
				value: props.value,
				disabled: props.disabled,
				onChange: (e) => props.onChange(e.target.value)
			}, props.options.map((o) => react.createElement("option", { key: o.value, value: o.value }, o.label)));
		}

		/** Ordered multi-select: checkbox pool on the left, ordered numbered rows with move/remove on the right. */
		function OrderEditor(props) {
			const catalog = props.catalog;
			const selected = parseList(props.value);
			const inPool = catalog.filter((c) => !selected.includes(c.value));
			const labelOf = (v) => {
				const hit = catalog.find((c) => c.value === v);
				return hit ? hit.label : v;
			};
			const move = (v, delta) => {
				const next = selected.slice();
				const i = next.indexOf(v);
				const j = i + delta;
				if (i < 0 || j < 0 || j >= next.length) return;
				next[i] = next[j];
				next[j] = v;
				props.onChange(next.join(","));
			};
			const remove = (v) => props.onChange(selected.filter((x) => x !== v).join(","));
			const add = (v) => props.onChange(selected.concat([v]).join(","));

			return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
				react.createElement("div", null,
					react.createElement("div", { style: { fontSize: "12px", opacity: 0.6, marginBottom: "4px" } }, "可用模型（来自模型设置，勾选加入）"),
					inPool.length === 0
						? react.createElement("div", { style: { fontSize: "12px", opacity: 0.45, padding: "4px 0" } }, "目录里的可搜索模型都已加入")
						: react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
							inPool.map((c) => react.createElement("label", { key: c.value, style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", cursor: "pointer" } },
								react.createElement("input", { type: "checkbox", checked: false, disabled: props.disabled, onChange: () => add(c.value) }),
								c.label
							))
						)
				),
				react.createElement("div", null,
					react.createElement("div", { style: { fontSize: "12px", opacity: 0.6, marginBottom: "4px" } }, "尝试顺序（自上而下，前一档失败/无引用才轮到下一档）"),
					selected.length === 0
						? react.createElement("div", { style: { fontSize: "12px", opacity: 0.45, padding: "4px 0" } }, "未选择时按模型设置的目录顺序")
						: react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
							selected.map((v, i) => react.createElement("div", { key: v, style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" } },
								react.createElement("span", { style: { opacity: 0.5, width: "16px" } }, String(i + 1) + "."),
								react.createElement("span", { style: chipStyle }, labelOf(v)),
								react.createElement("button", { type: "button", style: smallBtn, disabled: props.disabled || i === 0, onClick: () => move(v, -1) }, "↑"),
								react.createElement("button", { type: "button", style: smallBtn, disabled: props.disabled || i === selected.length - 1, onClick: () => move(v, 1) }, "↓"),
								react.createElement("button", { type: "button", style: smallBtn, disabled: props.disabled, title: "移除", onClick: () => remove(v) }, "✕")
							))
						)
				)
			);
		}

		function Card(props) {
			const scope = props.scope;
			const modelsScope = props.modelsScope;
			const useSyncExternalStore = react.useSyncExternalStore || ((subscribe, getSnapshot) => getSnapshot());
			const snapshot = useSyncExternalStore((callback) => scope.subscribe(callback), () => scope.getSnapshot());
			const modelsSnap = useSyncExternalStore((callback) => modelsScope.subscribe(callback), () => modelsScope.getSnapshot());

			const value = snapshot.value && typeof snapshot.value === "object" ? snapshot.value : {};
			const userLayer = snapshot.user && typeof snapshot.user === "object" ? snapshot.user : {};
			const catalog = readCatalog(modelsSnap.value);

			const openSt = react.useState(false);
			const open = openSt[0];
			const setOpen = openSt[1];
			const advSt = react.useState(false);
			const advOpen = advSt[0];
			const setAdvOpen = advSt[1];

			const draft0 = {
				chain: typeof value.chain === "string" ? value.chain : "",
				mode: typeof value.mode === "string" ? value.mode : "",
				model: typeof value.model === "string" ? value.model : "",
				autoOrder: typeof value.autoOrder === "string" ? value.autoOrder : "",
				reasoning: typeof value.reasoning === "string" ? value.reasoning : "",
				fallbackBaseURL: typeof value.fallbackBaseURL === "string" ? value.fallbackBaseURL : ""
			};
			for (const f of NUMBER_FIELDS) draft0[f.key] = value[f.key] === undefined || value[f.key] === null ? "" : String(value[f.key]);
			draft0.xsearch = value.xsearch === true;

			const st = react.useState(draft0);
			const draft = st[0];
			const setDraft = st[1];
			const busySt = react.useState(false);
			const busy = busySt[0];
			const setBusy = busySt[1];
			const msgSt = react.useState(null);
			const msg = msgSt[0];
			const setMsg = msgSt[1];

			function setF(field, v) {
				setDraft(function (prev) { const next = Object.assign({}, prev); next[field] = v; return next; });
			}

			async function save() {
				setBusy(true);
				setMsg(null);
				try {
					const writes = [];
					for (const key of ["chain", "mode", "model", "autoOrder", "reasoning", "fallbackBaseURL"].concat(NUMBER_FIELDS.map((n) => n.key))) {
						const raw = String(draft[key] === undefined || draft[key] === null ? "" : draft[key]).trim();
						const isNumber = NUMBER_FIELDS.some((n) => n.key === key);
						const currentResolved = value[key];
						const unchanged = raw.length === 0
							? (currentResolved === undefined || currentResolved === null || currentResolved === "")
							: (isNumber ? Number(raw) === currentResolved : raw === String(currentResolved));
						if (unchanged && !(key in userLayer)) continue;
						if (raw.length === 0) writes.push(scope.unset(key));
						else if (isNumber) writes.push(scope.set(key, parseInt(raw, 10)));
						else writes.push(scope.set(key, raw));
					}
					writes.push(scope.set("xsearch", draft.xsearch === true));
					for (const w of writes) await w;
					setMsg({ kind: "ok", text: "已保存。未填写的字段回退到组合层/.env。" });
				} catch (e) {
					setMsg({ kind: "err", text: "保存失败：" + String((e && e.message) || e) });
				} finally {
					setBusy(false);
				}
			}

			const disabled = busy === true || snapshot.writable !== true;
			const mode = draft.mode === "manual" ? "manual" : "auto";
			const chainKnown = draft.chain.length === 0 || CHAIN_PRESETS.some((p) => p.value === draft.chain);
			const reasoningKnown = draft.reasoning.length === 0 || REASONING_OPTIONS.some((o) => o.value === draft.reasoning);
			const hasGrok = catalog.some((c) => c.value.toLowerCase().includes("grok"));

			const header = react.createElement("button", {
				type: "button",
				onClick: () => setOpen(!open),
				style: { width: "100%", display: "flex", alignItems: "center", gap: "12px", padding: "14px 16px", background: "transparent", border: "none", color: "inherit", textAlign: "left", cursor: "pointer", font: "inherit" }
			},
				react.createElement("span", { style: { flex: 1, display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 } },
					react.createElement("span", { style: { fontSize: "15px", fontWeight: 600 } }, "网页搜索"),
					react.createElement("span", { style: { fontSize: "13px", opacity: 0.55 } }, "Parallel + 中转模型聚合 · 模型与顺序读取自模型设置")
				),
				react.createElement("span", { style: { opacity: 0.5, transform: open ? "rotate(180deg)" : "none", transition: "transform .16s" } }, "▾")
			);

			let body = null;
			if (open) {
				if (snapshot.status !== "ready") {
					body = react.createElement("div", { style: { padding: "0 16px 14px", fontSize: "12px", opacity: 0.6 } }, snapshot.status === "loading" ? "正在读取设置…" : "此命名空间不可用");
				} else {
					const engineSection = react.createElement(Section, { title: "引擎与模型" },
						react.createElement(Field, { label: "搜索引擎顺序", noRule: true },
							react.createElement(Select, {
								value: draft.chain,
								disabled,
								options: CHAIN_PRESETS.concat(chainKnown ? [] : [{ value: draft.chain, label: "当前值: " + draft.chain }]),
								onChange: (v) => setF("chain", v)
							})
						),
						react.createElement(Field, { label: "中转档模式" },
							react.createElement(Select, {
								value: mode,
								disabled,
								options: [{ value: "auto", label: "自动 — 按下方顺序逐个尝试" }, { value: "manual", label: "手动 — 固定用一个模型" }],
								onChange: (v) => setF("mode", v)
							})
						),
						mode === "manual"
							? react.createElement(Field, { label: "手动模型", hint: "列表来自 设置 → 模型 的供应商目录" },
								catalog.length > 0
									? react.createElement(Select, {
										value: draft.model,
										disabled,
										options: [{ value: "", label: "（未选择）" }].concat(catalog).concat(draft.model.length > 0 && !catalog.some((c) => c.value === draft.model) ? [{ value: draft.model, label: "当前值: " + draft.model }] : []),
										onChange: (v) => setF("model", v)
									})
									: react.createElement("input", { style: inputStyle, value: draft.model, placeholder: "provider::模型", disabled, onChange: (e) => setF("model", e.target.value) })
							)
							: react.createElement(Field, { label: "自动链顺序", hint: "留空则按模型设置的目录顺序自动排列" },
								react.createElement(OrderEditor, { catalog, value: draft.autoOrder, disabled, onChange: (v) => setF("autoOrder", v) })
							)
					);

					const behaviorSection = react.createElement(Section, { title: "回答行为" },
						react.createElement(Field, { label: "思考强度（reasoning effort）", noRule: true },
							react.createElement(Select, {
								value: draft.reasoning,
								disabled,
								options: REASONING_OPTIONS.concat(reasoningKnown ? [] : [{ value: draft.reasoning, label: "当前值: " + draft.reasoning }]),
								onChange: (v) => setF("reasoning", v)
							})
						),
						hasGrok
							? react.createElement(Field, { label: "grok 类模型加挂 x_search" },
								react.createElement("label", { style: { display: "flex", gap: "6px", alignItems: "center", fontSize: "13px", cursor: "pointer" } },
									react.createElement("input", { type: "checkbox", checked: draft.xsearch === true, disabled, onChange: (e) => setF("xsearch", e.target.checked) }),
									"web_search + x_search（可解析 X/Twitter 引用）"
								)
							)
							: null
					);

					const advToggle = react.createElement("button", { type: "button", style: { cursor: "pointer", fontSize: "12px", background: "transparent", border: "none", color: "inherit", opacity: 0.65, padding: 0, font: "inherit" } }, advOpen ? "收起 ▴" : "展开 ▾");

					const advancedSection = react.createElement(Section, { title: "高级 · 兜底与上限", right: advToggle ? react.createElement(advToggle.type, { ...advToggle.props, onClick: () => setAdvOpen(!advOpen) }) : null },
						advOpen
							? react.createElement(react.Fragment, null,
								react.createElement(Field, { label: "兜底 Base URL", hint: "仅当所选模型在模型配置里解析不到凭据时使用", noRule: true },
									react.createElement("input", { style: inputStyle, value: draft.fallbackBaseURL, placeholder: "https://…/v1", disabled, onChange: (e) => setF("fallbackBaseURL", e.target.value) })
								),
								react.createElement(Field, { label: "兜底 API Key", hint: "写入配置存储，保存后不再回显" },
									react.createElement("input", { style: inputStyle, type: "password", autoComplete: "off", value: draft.fallbackApiKeyText ?? "", placeholder: draft.fallbackConfigured ? "已配置 — 留空保持不变" : "未配置", disabled, onChange: (e) => setF("fallbackApiKeyText", e.target.value) })
								),
								react.createElement("div", { style: { display: "flex", gap: "10px" } },
									NUMBER_FIELDS.map((f, idx) => react.createElement("div", { key: f.key, style: { flex: 1, minWidth: 0 } },
										react.createElement(Field, { label: f.label, hint: f.hint, noRule: idx !== 0 },
											react.createElement("input", { style: inputStyle, value: draft[f.key], inputMode: "numeric", disabled, onChange: (e) => setF(f.key, e.target.value) })
										)
									))
								)
							)
							: react.createElement("div", { style: { fontSize: "12px", opacity: 0.5, padding: "2px 0 6px" } }, "兜底凭据、输出上限与超时。日常无需改动；留空一律回退 .env / 组合层。")
					);

					body = react.createElement("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))", margin: "0 16px", paddingBottom: "10px" } },
						engineSection,
						behaviorSection,
						advancedSection,
						react.createElement("div", { style: { display: "flex", gap: "8px", alignItems: "center", padding: "12px 0 4px", borderTop: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18))" } },
							react.createElement("button", { onClick: save, disabled, style: { cursor: "pointer", borderRadius: "8px", padding: "6px 16px", fontSize: "13px", border: "1px solid transparent", background: "var(--dsw-alias-brand-primary, #2f6feb)", color: "#fff" } }, busy ? "保存中…" : "保存"),
							react.createElement("span", { style: { fontSize: "12px", opacity: 0.55 } }, snapshot.writable ? "保存到用户层；留空的字段回退 .env/组合层" : "当前连接不接受写入")
						),
						msg ? react.createElement("div", { style: { fontSize: "12px", whiteSpace: "pre-wrap", color: msg.kind === "ok" ? "var(--dsw-alias-state-success, #22c55e)" : "var(--dsw-alias-state-error, #ef4444)" } }, msg.text) : null
					);
				}
			}

			return react.createElement("div", {
				style: {
					border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))",
					borderRadius: "12px",
					listStyle: "none"
				}
			}, header, body);
		}

		const inject = ["slots", "settingsScope"];

		function apply(ctx) {
			const scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
			const modelsScope = ctx.settingsScope.bind({ namespace: MODELS_NAMESPACE });
			ctx.slots.inject("settings.plugin.item", function* () {
				yield ctx.slots.register(
					{ name: "settings.plugin.item", key: NAMESPACE },
					function OpenAiSearchSettingsCard() {
						return react.createElement(Card, { scope, modelsScope });
					}
				);
			});
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
