import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import { executeDshSearchRequest, prepareDshSearchRequest } from "@ccr/core/gateway/features/dsh-search.ts";

function fixture(body = { query: "  Shanghai weather  ", count: 10, need_content: false, ori_question: "weather?" }) {
  const config = createDefaultAppConfig();
  config.Providers = [
    { name: "Bailian", models: ["qwen"], api_key: "bailian-key", enhancedSearch: { enabled: true } },
    { name: "Official", models: ["kimi-for-coding"], api_key: "kimi-key",
      capabilities: [{ type: "openai_chat_completions", baseUrl: "https://api.kimi.com/coding/v1" }] },
    { name: "Other", models: ["model"], api_key: "other-key", baseUrl: "https://other.example.test/v1" }
  ];
  return { config, profile: { agent: "claude-code", enabled: true, model: "Bailian/qwen" }, method: "POST",
    path: "/v1/tools/search", body: Buffer.from(JSON.stringify(body)) };
}

test("DSH search resolves the authenticated profile default on the tools search paths only", () => {
  const input = fixture();
  for (const agent of ["claude-code", "codex", "kimi"]) {
    const dsh = prepareDshSearchRequest({ ...input, profile: { ...input.profile, agent } });
    assert.equal(dsh.model, "Bailian/qwen");
    assert.equal(dsh.search.provider.name, "Bailian");
    assert.equal(dsh.search.backend, "bailian");
    assert.equal(dsh.search.query, "Shanghai weather");
    assert.equal(dsh.count, 10);
  }
  for (const path of ["/v1/tools/search", "/tools/search", "/v1/tools/search/"]) {
    assert.ok(prepareDshSearchRequest({ ...input, path }).search);
  }
  for (const overrides of [{ method: "GET" }, { path: "/v1/search" }, { path: "/search" }, { path: "/v1/messages" }]) {
    assert.equal(prepareDshSearchRequest({ ...input, ...overrides }), undefined);
  }
});

test("invalid DSH requests and unsupported profile defaults fail without an upstream request", async (t) => {
  t.mock.method(globalThis, "fetch", () => { assert.fail("invalid searches must not contact an upstream"); });
  const input = fixture();
  for (const body of [undefined, Buffer.from("invalid JSON"), Buffer.from("[]"), Buffer.from("{}"),
    Buffer.from('{"query":42}'), Buffer.from('{"query":"  "}'), Buffer.from('{"query":"x"}'),
    Buffer.from('{"query":"weather","count":0}'), Buffer.from('{"query":"weather","count":"10"}')]) {
    const result = await executeDshSearchRequest(prepareDshSearchRequest({ ...input, body }));
    assert.equal(result.statusCode, 400, result.body);
    assert.match(JSON.parse(result.body).error.message, /query|count/);
  }
  for (const profile of [undefined, { ...input.profile, model: "" }, { ...input.profile, model: "Missing/model" },
    { ...input.profile, model: "Other/model" }, { ...input.profile, enabled: false }]) {
    const result = await executeDshSearchRequest(prepareDshSearchRequest({ ...input, profile }));
    assert.equal(result.statusCode, 503, result.body);
  }
});

test("DSH replies use the documented result shape, honour count and exclude non-HTTP links", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ search_results: [
    { title: "Unsafe", url: "javascript:alert(1)" },
    { title: "First", url: "https://example.test/1", snippet: "evidence" },
    ...Array.from({ length: 10 }, (_, index) => ({ title: `${index}`, url: `https://example.test/n${index}` }))
  ] }));
  const input = fixture({ query: "weather", count: 2 });
  input.profile.model = "Official/kimi-for-coding";
  const result = await executeDshSearchRequest(prepareDshSearchRequest(input));
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(JSON.parse(result.body), { results: [
    { url: "https://example.test/1", title: "First", snippet: "evidence", date: null },
    { url: "https://example.test/n0", title: "0", snippet: "", date: null }
  ] });
  const unbounded = await executeDshSearchRequest(prepareDshSearchRequest({ ...input,
    body: Buffer.from('{"query":"weather"}') }));
  assert.equal(JSON.parse(unbounded.body).results.length, 8);
});
