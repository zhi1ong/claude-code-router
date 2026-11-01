import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import { executeKimiClientSearchRequest, prepareKimiClientSearchRequest } from "@ccr/core/gateway/features/kimi-client-search.ts";
import { prepareClaudeCodeWebSearchSideQuery } from "@ccr/core/gateway/features/claude-code-web-search.ts";

function fixture() {
  const config = createDefaultAppConfig();
  config.Providers = [
    { name: "Bailian", models: ["kimi-for-coding"], api_key: "bailian-key", enhancedSearch: { enabled: true } },
    { name: "Official", models: ["kimi-for-coding"], api_key: "kimi-key",
      capabilities: [{ type: "openai_chat_completions", baseUrl: "https://api.kimi.com/coding/v1" }] },
    { name: "Other", models: ["model"], api_key: "other-key", baseUrl: "https://other.example.test/v1" }
  ];
  return { config, profile: { agent: "kimi", enabled: true, model: "Official/kimi-for-coding",
    availableModels: ["Bailian/kimi-for-coding", "Other/model"] }, method: "POST", path: "/v1/search",
    body: Buffer.from('{"text_query":"  Shanghai weather  ","model":"Bailian/kimi-for-coding"}') };
}

test("Kimi search uses only the profile default and shares CC provider resolution, including virtual aliases", () => {
  const input = fixture();
  input.config.virtualModelProfiles = [{ enabled: true, match: { exactAliases: ["search-default", "kimi-for-coding"] },
    baseModel: { mode: "fixed", fixedModel: "Bailian/kimi-for-coding" },
    materialization: { enabled: true, includeInGatewayModels: true } }];
  for (const [model, provider, backend] of [["Official/kimi-for-coding", "Official", "kimi"],
    ["Bailian,kimi-for-coding", "Bailian", "bailian"], ["Fusion/search-default", "Bailian", "bailian"]]) {
    input.profile.model = model;
    const kimi = prepareKimiClientSearchRequest(input);
    const cc = prepareClaudeCodeWebSearchSideQuery({ config: input.config, method: "POST", path: "/v1/messages",
      routedModel: model, body: Buffer.from(JSON.stringify({ model, messages: [{ role: "user",
        content: "Perform a web search for the query: Shanghai weather" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }] })) });
    assert.equal(kimi.search.provider.name, provider);
    assert.equal(kimi.search.backend, backend);
    assert.equal(kimi.search.provider, cc.provider);
    assert.equal(kimi.search.query, "Shanghai weather");
  }
  for (const path of ["/v1/search", "/search", "/v1/search/", "/search/"]) {
    assert.ok(prepareKimiClientSearchRequest({ ...input, path }).search);
  }
  for (const overrides of [{ method: "GET" }, { path: "/v1/messages" }, { path: "/v1/chat/completions" }]) {
    assert.equal(prepareKimiClientSearchRequest({ ...input, ...overrides }), undefined);
  }
});

test("invalid query and unavailable profile defaults fail without any upstream request or global fallback", async (t) => {
  t.mock.method(globalThis, "fetch", () => { assert.fail("invalid searches must not contact an upstream"); });
  const input = fixture();
  for (const body of [undefined, Buffer.alloc(0), Buffer.from("invalid JSON"), Buffer.from("[]"),
    Buffer.from("null"), Buffer.from("{}"), Buffer.from('{"text_query":42}'), Buffer.from('{"text_query":"  "}')]) {
    const result = await executeKimiClientSearchRequest(prepareKimiClientSearchRequest({ ...input, body }));
    assert.equal(result.statusCode, 400, result.body);
    assert.match(JSON.parse(result.body).error.message, /text_query/);
  }
  for (const profile of [undefined, { ...input.profile, model: "" }, { ...input.profile, model: "Missing/model" },
    { ...input.profile, model: "Other/model" }, { ...input.profile, enabled: false }, { ...input.profile, agent: "claude-code" }]) {
    const result = await executeKimiClientSearchRequest(prepareKimiClientSearchRequest({ ...input, profile }));
    assert.equal(result.statusCode, 503, result.body);
  }
  input.config.Providers[1].enabled = false;
  assert.equal((await executeKimiClientSearchRequest(prepareKimiClientSearchRequest(input))).statusCode, 503);
  input.profile.model = "Bailian/kimi-for-coding";
  input.config.Providers[0].enhancedSearch.enabled = false;
  assert.equal((await executeKimiClientSearchRequest(prepareKimiClientSearchRequest(input))).statusCode, 503);
});

test("Kimi replies preserve snippets, bound results and exclude non-HTTP links", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ search_results: [
    { title: "Unsafe", url: "javascript:alert(1)" }, { title: "Invalid", url: "not a URL" },
    { title: "t".repeat(600), url: `https://example.test/${"u".repeat(2200)}`, snippet: "s".repeat(4500) },
    { title: "No snippet", url: "https://example.test/none" },
    ...Array.from({ length: 10 }, (_, index) => ({ title: `${index}`, url: `https://example.test/${index}` }))
  ] }));
  const result = await executeKimiClientSearchRequest(prepareKimiClientSearchRequest(fixture()));
  assert.equal(result.statusCode, 200, result.body);
  const results = JSON.parse(result.body).search_results;
  assert.equal(results.length, 8);
  assert.equal(results[0].title.length, 500);
  assert.equal(results[0].url.length, 2000);
  assert.equal(results[0].snippet.length, 4000);
  assert.deepEqual(results[1], { title: "No snippet", url: "https://example.test/none", snippet: "" });
});
