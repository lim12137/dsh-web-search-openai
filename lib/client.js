window.__ModuleLoader__.load({
	id: "dsh-web-search-openai",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const NAMESPACE = "web-search-openai";

		const TEXT_FIELDS = [
			{ key: "chain", label: "搜索引擎顺序（parallel,openai）" },
			{ key: "mode", label: "openai 后端模式（auto | manual）" },
			{ key: "model", label: "手动模式模型（provider::模型）" },			{ key: "autoOrder", label: "自动链顺序覆盖（provider::模型, ...）" },
			{ key: "fallbackBaseURL", label: "兜底 Base URL" }
		];
		const SECRET_FIELDS = [{ key: "fallbackApiKey", label: "兜底 API Key（保存后不再回显）" }];
		const NUMBER_FIELDS = [
			{ key: "maxOutputTokens", label: "单次回答输出 token 上限" },
			{ key: "timeoutMs", label: "单次模型尝试超时（毫秒）" }
		];

		function Field(props) {
			return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "4px", padding: "10px 0", borderTop: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))" } },
				react.createElement("label", { style: { fontSize: "13px", fontWeight: 500, opacity: 0.85 } }, props.label),
				props.children
			);
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

		function Card(props) {
			const scope = props.scope;
			const snapshot = scope.getSnapshot();
			const value = snapshot.value && typeof snapshot.value === "object" ? snapshot.value : {};

			const draft0 = {};
			for (const f of TEXT_FIELDS) draft0[f.key] = typeof value[f.key] === "string" ? value[f.key] : "";
			for (const f of SECRET_FIELDS) draft0[f.key] = "";
			for (const f of NUMBER_FIELDS) draft0[f.key] = value[f.key] === undefined || value[f.key] === null ? "" : String(value[f.key]);
			draft0.xsearch = value.xsearch === true;

			const st = react.useState(draft0);
			const draft = st[0];
			const setDraft = st[1];
			const busy0 = react.useState(false);
			const busy = busy0[0];
			const setBusy = busy0[1];
			const msg0 = react.useState(null);
			const msg = msg0[0];
			const setMsg = msg0[1];

			function setF(field, v) {
				setDraft(function (prev) { const next = Object.assign({}, prev); next[field] = v; return next; });
			}

			async function save() {
				setBusy(true);
				setMsg(null);
				try {
					const writes = [];
					for (const f of TEXT_FIELDS.concat(NUMBER_FIELDS)) {
						const raw = String(draft[f.key] === undefined || draft[f.key] === null ? "" : draft[f.key]).trim();
						if (raw.length === 0) writes.push(scope.unset(f.key));
						else if (NUMBER_FIELDS.some((n) => n.key === f.key)) writes.push(scope.set(f.key, parseInt(raw, 10)));
						else writes.push(scope.set(f.key, raw));
					}
					if (draft.fallbackApiKey.trim().length > 0) writes.push(scope.set("fallbackApiKey", draft.fallbackApiKey.trim()));
					writes.push(scope.set("xsearch", draft.xsearch === true));
					for (const w of writes) await w;
					setMsg({ kind: "ok", text: "已保存。未填写的字段回退到组合层/.env。" });
					setDraft(function (prev) { const next = Object.assign({}, prev); next.fallbackApiKey = ""; return next; });
				} catch (e) {
					setMsg({ kind: "err", text: "保存失败：" + String((e && e.message) || e) });
				} finally {
					setBusy(false);
				}
			}

			const disabled = busy === true || snapshot.writable !== true;

			return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "8px", padding: "8px 0" } },
				react.createElement("div", { style: { fontSize: "13px", fontWeight: 600 } }, "OpenAI 网页搜索（Responses API · 读 DSH 模型配置）"),
				snapshot.status !== "ready"
					? react.createElement("div", { style: { fontSize: "12px", opacity: 0.6 } }, snapshot.status === "loading" ? "正在读取设置…" : "此命名空间不可用")
					: react.createElement(react.Fragment, null,
						TEXT_FIELDS.map((f) => react.createElement(Field, { key: f.key, label: f.label },
							react.createElement("input", { style: inputStyle, value: draft[f.key], onChange: (e) => setF(f.key, e.target.value), disabled: disabled })
						)),
						SECRET_FIELDS.map((f) => react.createElement(Field, { key: f.key, label: f.label },
							react.createElement("input", { style: inputStyle, type: "password", value: draft[f.key], placeholder: "留空保持不变", onChange: (e) => setF(f.key, e.target.value), disabled: disabled })
						)),
						NUMBER_FIELDS.map((f) => react.createElement(Field, { key: f.key, label: f.label },
							react.createElement("input", { style: inputStyle, value: draft[f.key], onChange: (e) => setF(f.key, e.target.value), disabled: disabled })
						)),
						react.createElement(Field, { label: "对 grok 类模型启用 x_search" },
							react.createElement("label", { style: { display: "flex", gap: "6px", alignItems: "center", fontSize: "13px" } },
								react.createElement("input", { type: "checkbox", checked: draft.xsearch === true, onChange: (e) => setF("xsearch", e.target.checked), disabled: disabled }),
								"web_search + x_search"
							)
						),
						react.createElement("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
							react.createElement("button", { onClick: save, disabled: disabled, style: { cursor: "pointer", borderRadius: "8px", padding: "6px 14px", fontSize: "13px", border: "1px solid transparent", background: "#2f6feb", color: "#fff" } }, busy ? "保存中…" : "保存"),
							react.createElement("span", { style: { fontSize: "12px", opacity: 0.55 } }, snapshot.writable ? "保存到用户层；留空的字段回退 .env/组合层" : "当前连接不接受写入")
						),
						msg ? react.createElement("div", { style: { fontSize: "12px", whiteSpace: "pre-wrap", color: msg.kind === "ok" ? "#22c55e" : "#ef4444" } }, msg.text) : null
					)
			);
		}

		const inject = ["slots", "settingsScope"];

		function apply(ctx) {
			const scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
			ctx.slots.inject("settings.plugin.item", function* () {
				yield ctx.slots.register(
					{ name: "settings.plugin.item", key: NAMESPACE },
					function OpenAiSearchSettingsCard() {
						return react.createElement(Card, { scope: scope });
					}
				);
			});
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
