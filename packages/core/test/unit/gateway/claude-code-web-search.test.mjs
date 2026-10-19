import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import { executeClaudeCodeWebSearchSideQuery, prepareClaudeCodeWebSearchProfileRequest, prepareClaudeCodeWebSearchSideQuery } from "@ccr/core/gateway/features/claude-code-web-search.ts";
import { kimiSearchTarget, searchKimiWeb } from "@ccr/core/gateway/features/kimi-search.ts";
import { readProviderCredentialCooldown, reserveProviderCredentialUsage } from "@ccr/core/providers/credential-pool.ts";

const kimi = { id: "kimi", name: "Official", models: ["kimi-for-coding"], api_key: "model-key",
  capabilities: [{ type: "anthropic_messages", baseUrl: "https://api.kimi.com/coding/" }] };
const query = { model: "Official/kimi-for-coding", stream: false, max_tokens: 64,
  messages: [{ role: "user", content: "Perform a web search for the query: 上海天气" }],
  tools: [{ type: "web_search_20250305", name: "web_search" }] };

function prepare(config, body = query, routedModel = body.model) {
  return prepareClaudeCodeWebSearchSideQuery({ config, method: "POST", path: "/v1/messages",
    body: Buffer.from(JSON.stringify(body)), routedModel, requestedModel: body.model });
}

function configFor(provider = kimi) {
  const config = createDefaultAppConfig();
  config.Providers = [provider];
  config.providerPlugins = [];
  return config;
}

test("profile default search routing only applies to enabled Claude Code profiles and dedicated searches", () => {
  const profile = { agent: "claude-code", enabled: true, model: "Bailian/search" };
  const input = { method: "POST", path: "/v1/messages", body: Buffer.from(JSON.stringify(query)), profile };
  for (const overrides of [
    { profile: undefined },
    { profile: { ...profile, agent: "codex" } },
    { profile: { ...profile, enabled: false } },
    { profile: { ...profile, model: "" } },
    { method: "GET" },
    { path: "/v1/messages/count_tokens" },
    { body: undefined },
    { body: Buffer.from("invalid JSON") },
    { body: Buffer.from(JSON.stringify({ ...query, messages: [{ role: "user", content: "hello" }] })) },
    { body: Buffer.from(JSON.stringify({ ...query, tools: [...query.tools, { name: "Read", input_schema: {} }] })) }
  ]) {
    assert.equal(prepareClaudeCodeWebSearchProfileRequest({ ...input, ...overrides }), undefined);
  }
});

test("search backend follows the routed upstream, including Bailian-hosted Kimi models", () => {
  const config = configFor();
  config.Providers.unshift({ id: "bailian", name: "Bailian", models: kimi.models,
    enhancedSearch: { enabled: true },
    capabilities: [{ type: "anthropic_messages", baseUrl: "https://example.maas.aliyuncs.com/apps/anthropic" }] });
  assert.equal(prepare(config).backend, "kimi");
  assert.equal(prepare(config, query, "Bailian/kimi-for-coding").backend, "bailian");
  assert.equal(prepare(config, query, "Missing/kimi-for-coding"), undefined);
  assert.equal(prepare(config, { ...query, messages: [{ role: "user", content: "hello" }] }), undefined);
  assert.equal(prepare(config, { ...query, tools: [...query.tools, { name: "Read", input_schema: {} }] }), undefined);
  assert.equal(prepare(config, { ...query, tool_choice: { type: "none" } }), undefined);
  const longQuery = "x".repeat(1000);
  assert.equal(prepare(config, { ...query, messages: [{ role: "user",
    content: "Perform a web search for the query: " + longQuery }] }).query, longQuery);
  config.Providers[1] = { ...kimi, enabled: false };
  assert.equal(prepare(config), undefined);
});

test("both official protocol endpoints use /coding/v1/search without matching model or provider names", () => {
  for (const type of ["anthropic_messages", "openai_chat_completions"]) {
    const provider = { ...kimi, capabilities: [{ type,
      baseUrl: type === "anthropic_messages" ? "https://api.kimi.com/coding/" : "https://api.kimi.com/coding/v1/" }] };
    assert.deepEqual(kimiSearchTarget(provider), { url: "https://api.kimi.com/coding/v1/search", protocol: type });
  }
  for (const baseUrl of ["https://proxy.example.test/coding/v1", "https://api.kimi.com.example.test/coding/",
    "https://api.kimi.com/other", "http://api.kimi.com/coding/v1"]) {
    assert.equal(kimiSearchTarget({ ...kimi, capabilities: [{ type: "anthropic_messages", baseUrl }] }), undefined);
  }
});

test("Kimi uses the credential pool, provider headers and shared result filtering and limits", async (t) => {
  const provider = { ...kimi, extraHeaders: { "X-Custom": "provider" },
    credentials: [{ id: "off", enabled: false, api_key: "disabled" },
      { id: "first", api_key: "limited", limits: { maxRequests: 1, windowMs: 60000 } },
      { id: "second", api_key: "selected", priority: 2 }] };
  assert.equal(reserveProviderCredentialUsage(provider, provider.credentials[1], { totalTokens: 0, imageCount: 0 }), true);
  let captured;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    captured = { url: String(url), ...init };
    return Response.json({ search_results: [
      { title: "Weather", url: "https://sub.example.test/weather", snippet: "Sunny" },
      { title: "Wrong host", url: "https://notexample.test/weather" },
      { title: "Unsafe", url: "javascript:alert(1)" },
      ...Array.from({ length: 12 }, (_, index) => ({ title: "x".repeat(600),
        url: `https://example.test/${index}`, snippet: "s".repeat(4500) }))
    ] });
  });
  const context = prepare(configFor(provider), { ...query, tools: [{ ...query.tools[0], allowed_domains: ["example.test"] }] });
  const result = await executeClaudeCodeWebSearchSideQuery(context);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(captured.url, "https://api.kimi.com/coding/v1/search");
  assert.equal(captured.method, "POST");
  assert.equal(captured.redirect, "manual");
  assert.equal(captured.headers.authorization, "Bearer selected");
  assert.equal(captured.headers["x-custom"], "provider");
  assert.match(captured.headers["user-agent"], /^kimi-code-cli\//);
  assert.equal(captured.headers["x-msh-platform"], "kimi_code_cli");
  assert.deepEqual(JSON.parse(captured.body), { text_query: "上海天气" });
  const message = JSON.parse(result.body);
  assert.equal(message.content[1].content.length, 8);
  assert.equal(message.content[1].content[1].title.length, 500);
  assert.match(message.content[2].text, /Sunny/);
  assert.doesNotMatch(message.content[2].text, /notexample|javascript/);
  assert.equal(message.content[2].text.includes("s".repeat(4001)), false);
});

test("search-only cooldowns fail closed and preserve model credentials", async (t) => {
  const provider = { ...kimi, id: "search-pool", name: "Search pool",
    credentials: [{ id: "first", api_key: "first-key", priority: 1 }, { id: "second", api_key: "second-key", priority: 2 }] };
  const config = configFor(provider);
  const context = prepare(config, { ...query, model: "Search pool/kimi-for-coding" });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls.push(init.headers.authorization);
    return new Response("private upstream error", { status: calls.length === 1 ? 401 : 429 });
  });
  for (const expected of [502, 502, 503]) {
    const result = await executeClaudeCodeWebSearchSideQuery(context);
    assert.equal(result.statusCode, expected);
    assert.doesNotMatch(result.body, /private upstream error|first-key|second-key/);
  }
  assert.deepEqual(calls, ["Bearer first-key", "Bearer second-key"]);
  for (const credential of provider.credentials) assert.equal(readProviderCredentialCooldown(provider, credential), undefined);
  provider.credentials[0].api_key = "rotated-key";
  t.mock.method(globalThis, "fetch", async () => Response.json({ search_results: [] }));
  assert.equal((await executeClaudeCodeWebSearchSideQuery(context)).statusCode, 200);
});

test("Kimi reuses live OAuth refresh and scopes provider plugins to the selected upstream", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-kimi-search-oauth-"));
  const previousHome = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = root;
  t.after(() => { if (previousHome === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = previousHome; });
  writeFileSync(path.join(root, "config.toml"), '[providers.kimi]\ntype = "kimi"\nbase_url = "https://api.kimi.com/coding/v1"\noauth = { storage = "file", key = "oauth/kimi-code", oauth_host = "http://127.0.0.1" }\n');
  mkdirSync(path.join(root, "credentials"));
  const credentialFile = path.join(root, "credentials", "kimi-code.json");
  writeFileSync(credentialFile, JSON.stringify({ access_token: "expired", refresh_token: "refresh", expires_at: 1 }));
  const config = configFor();
  config.providerPlugins = [
    { key: "ccr-local-agent-kimi-cli-oauth", providerName: "KIMI::anthropic_messages",
      kimiOauth: { key: "oauth/kimi-code", oauthHost: "http://127.0.0.1" },
      auth: { headers: { authorization: "Bearer stale-copy" } }, request: { headers: { "X-Custom": "matching" } } },
    { key: "other", providerName: "Unrelated", auth: { headers: { authorization: "Bearer wrong-provider" } } }
  ];
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith("/api/oauth/token")) {
      return Response.json({ access_token: "fresh-token", refresh_token: "fresh-refresh", expires_in: 3600 });
    }
    assert.equal(init.headers.authorization, "Bearer fresh-token");
    assert.equal(init.headers["x-custom"], "matching");
    assert.equal(Object.keys(init.headers).filter(name => name.toLowerCase() === "user-agent").length, 1);
    return Response.json({ search_results: [] });
  });
  const result = await executeClaudeCodeWebSearchSideQuery(prepare(config));
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(calls, ["http://127.0.0.1/api/oauth/token", "https://api.kimi.com/coding/v1/search"]);
  assert.equal(JSON.parse(readFileSync(credentialFile, "utf8")).access_token, "fresh-token");
});

test("invalid, oversized, redirected and failed Kimi responses cannot become empty successful searches", async (t) => {
  for (const [name, response] of [
    ["bad JSON", new Response("private data")], ["wrong shape", Response.json({ error: "private data" })],
    ["oversized", new Response("x".repeat(2 * 1024 * 1024 + 1))],
    ["redirect", new Response(null, { status: 302, headers: { location: "https://example.test" } })],
    ["server error", new Response("private data", { status: 500 })]
  ]) await t.test(name, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return response; });
    const result = await executeClaudeCodeWebSearchSideQuery(prepare(configFor()));
    assert.equal(result.statusCode, 502);
    assert.doesNotMatch(result.body, /private data|model-key/);
    assert.equal(calls, 1);
  });
});

test("deadline and caller cancellation close a hanging Kimi response", async (t) => {
  for (const callerCancels of [false, true]) await t.test(callerCancels ? "caller" : "deadline", async (t) => {
    let cancelled = false;
    const controller = new AbortController();
    t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
      cancel() { cancelled = true; }
    })));
    const timer = setTimeout(() => controller.abort(new Error("client disconnected")), callerCancels ? 20 : 1000);
    try {
      await assert.rejects(searchKimiWeb({ config: {}, provider: kimi, apiKey: "model-key", query: "weather",
        timeoutMs: callerCancels ? 1000 : 20, signal: controller.signal }),
      callerCancels ? /client disconnected/ : { name: "TimeoutError" });
      assert.equal(cancelled, true);
    } finally { clearTimeout(timer); }
  });
});
