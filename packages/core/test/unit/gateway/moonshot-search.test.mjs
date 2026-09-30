import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import {
  bailianEnhancedSearchEndpointEnv,
  executeMoonshotSearchRequest,
  prepareMoonshotSearchRequest
} from "@ccr/core/gateway/features/bailian-enhanced-search/index.ts";

function enabledConfig() {
  const config = createDefaultAppConfig();
  config.Providers = [{
    enhancedSearch: { apiKey: "test-search-key", enabled: true },
    id: "bailian", models: ["glm-5.3"], name: "Alibaba Bailian", type: "anthropic_messages"
  }, {
    id: "other", models: ["other-model"], name: "Other provider", type: "anthropic_messages"
  }];
  return config;
}

function prepare(config = enabledConfig(), body = Buffer.from('{"text_query":"上海天气"}'), method = "POST", path = "/v1/search") {
  return prepareMoonshotSearchRequest({ config, method, path, body,
    profile: { model: "Alibaba Bailian/glm-5.3" } });
}

test("moonshot_search matches its endpoint and follows the profile main model provider", () => {
  assert.equal(prepare().query, "上海天气");
  assert.equal(prepare(undefined, undefined, "POST", "/search").query, "上海天气");
  assert.equal(prepare(undefined, undefined, "GET"), undefined);
  assert.equal(prepare(undefined, undefined, "POST", "/v1/web_search"), undefined);
  assert.equal(prepare(undefined, undefined, "POST", "/v1/messages"), undefined);
  assert.equal(prepareMoonshotSearchRequest({ config: enabledConfig(), method: "POST", path: "/v1/search", body: undefined }), undefined);
  let config = enabledConfig();
  config.Providers[1].enhancedSearch = { apiKey: "second-key", enabled: true };
  const otherProfile = { model: "Other provider/other-model", availableModels: ["Alibaba Bailian/glm-5.3"] };
  const input = { method: "POST", path: "/v1/search", body: Buffer.from('{"text_query":"上海天气"}') };
  assert.equal(prepareMoonshotSearchRequest({ ...input, config, profile: otherProfile }).provider, config.Providers[1]);
  config.virtualModelProfiles = [{ enabled: true, match: { exactAliases: ["search-main"] },
    baseModel: { mode: "fixed", fixedModel: "Other provider/other-model" } }];
  config = structuredClone(config);
  assert.equal(prepareMoonshotSearchRequest({ ...input, config, profile: { model: "Fusion/search-main" } }).provider, config.Providers[1]);
  assert.equal(prepareMoonshotSearchRequest({ ...input, config, profile: { availableModels: ["Other provider/other-model"] } }).provider, config.Providers[1]);
  assert.equal(prepareMoonshotSearchRequest({ ...input, config }).provider, undefined);
  config.Providers[0].enabled = false;
  config = structuredClone(config);
  assert.equal(prepare(config).provider, undefined);
  config.Providers[1].enhancedSearch.enabled = false;
  assert.equal(prepareMoonshotSearchRequest({ ...input, config, profile: otherProfile }).provider, config.Providers[1]);
});

test("moonshot_search validates text_query before execution", () => {
  const invalid = [
    Buffer.alloc(0),
    Buffer.from("not json"),
    Buffer.from(JSON.stringify({})),
    Buffer.from(JSON.stringify({ text_query: "" })),
    Buffer.from(JSON.stringify({ text_query: "a" })),
    Buffer.from(JSON.stringify({ text_query: 42 })),
    Buffer.from(JSON.stringify([]))
  ];
  for (const body of invalid) {
    const context = prepare(undefined, body);
    assert.ok(context, `a validation error context must be prepared for ${body}`);
    assert.match(context.validationError, /text_query/);
  }
  assert.equal(prepare(undefined, Buffer.from('{"text_query":"  上海天气  "}')).query, "上海天气");
});

test("moonshot_search bounds result fields and fills a missing snippet", async () => {
  const pages = [
    { title: "t".repeat(1_000), url: `https://example.test/${"u".repeat(3_000)}`, snippet: "s".repeat(5_000) },
    { title: "No snippet", url: "https://example.test/none" },
    ...Array.from({ length: 10 }, (_, index) => ({ title: `Result ${index}`, url: `https://example.test/${index}` }))
  ];
  const previousFetch = globalThis.fetch;
  const previousEndpoint = process.env[bailianEnhancedSearchEndpointEnv];
  try {
    process.env[bailianEnhancedSearchEndpointEnv] = "http://127.0.0.1/bailian-enhanced-search-mcp";
    globalThis.fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body));
      if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result = payload.method === "initialize" ? {} : { content: [{ type: "text", text: JSON.stringify({ pages }) }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }), { headers: { "content-type": "application/json" } });
    };
    const reply = await executeMoonshotSearchRequest(prepare());
    const results = JSON.parse(reply.body).search_results;
    assert.equal(results.length, 8);
    assert.equal(results[0].title.length, 500);
    assert.equal(results[0].url.length, 2_000);
    assert.equal(results[0].snippet.length, 4_000);
    assert.deepEqual(results[1], { title: "No snippet", url: "https://example.test/none", snippet: "" });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousEndpoint === undefined) delete process.env[bailianEnhancedSearchEndpointEnv];
    else process.env[bailianEnhancedSearchEndpointEnv] = previousEndpoint;
  }
});
