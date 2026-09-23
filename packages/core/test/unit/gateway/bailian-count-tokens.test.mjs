import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import { ClaudeCodeRouterPlugin } from "@ccr/core/gateway/claude-code-router-plugin.ts";
import { createGatewayPlugin } from "@ccr/core/gateway/core-runtime/router-plugin.ts";
import { forwardBailianCountTokens, isBailianAnthropicBaseUrl } from "@ccr/core/gateway/features/bailian-count-tokens.ts";
import { GatewayHttpRequestHandler } from "@ccr/core/gateway/http/request-handler.ts";

const payload = {
  model: "claude-count-alias",
  system: [{ type: "text", text: "Be concise.", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  tools: [{ name: "get_time", input_schema: { type: "object", properties: {} } }],
  future_option: { preserve: true }
};

function configFor(baseUrl = "https://ws-test.cn-beijing.maas.aliyuncs.com/apps/anthropic") {
  const config = createDefaultAppConfig();
  config.APIKEY = "client-key";
  config.APIKEYS = [{ createdAt: new Date(0).toISOString(), id: "count-client", key: "client-key" }];
  config.profile.profiles = [];
  config.Providers = [{
    id: "bailian", name: "Bailian", models: ["qwen3.7-plus"],
    api_key: "provider-key", capabilities: [{ baseUrl, type: "anthropic_messages" }]
  }];
  config.Router.builtInRules = { "claude-code": { enabled: false }, codex: { enabled: false } };
  config.Router.rules = [{
    id: "map-count-model", name: "Map count model", type: "condition", enabled: true,
    condition: { left: "request.url", operator: "contains", right: "/v1/messages" },
    rewrites: [{ key: "request.body.model", operation: "set", value: "bailian/qwen3.7-plus" }]
  }];
  return config;
}

function requestHeaders() {
  return {
    "content-type": "application/json", "x-api-key": "client-key", authorization: "Bearer client-key",
    cookie: "client-cookie", "x-ccr-routed-model": "attacker/model", "x-auth-api-key-id": "attacker",
    "anthropic-beta": "future-feature", "anthropic-version": "2023-06-01", "x-client-custom": "preserve"
  };
}

class Capture extends Writable {
  constructor() { super(); this.headers = {}; this.chunks = []; this.statusCode = 0; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; }
  getHeader(name) { return this.headers[name.toLowerCase()]; }
  writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); return this; }
  _write(chunk, _encoding, done) { this.chunks.push(Buffer.from(chunk)); done(); }
  text() { return Buffer.concat(this.chunks).toString(); }
}

async function invoke(mode, config, body = payload, headers = requestHeaders()) {
  if (mode === "single") {
    const plugin = await createGatewayPlugin({ plugin: { config: { appConfig: config } } });
    const route = plugin.httpRoutes.find((entry) => entry.path === "/v1/messages/count_tokens");
    const response = { statusCode: 200, headers: {} };
    const reply = {
      header(name, value) { response.headers[name] = value; return this; },
      code(code) { response.statusCode = code; return this; },
      send(value) { response.body = value; return value; }
    };
    const result = await route.handler({ request: { method: "POST", url: route.path, headers, body }, reply });
    response.body ??= result;
    response.text = () => Buffer.isBuffer(response.body) ? response.body.toString() : JSON.stringify(response.body);
    return response;
  }
  const router = new ClaudeCodeRouterPlugin(config);
  const handler = new GatewayHttpRequestHandler({
    getConfig: () => config, getPlugin: () => router, getBrowserAutomationMcpIntegration: () => undefined,
    getRuntimeConfigControlStatus: () => ({}),
    getStatus: () => ({ endpoint: "http://127.0.0.1:3456", coreEndpoint: "http://127.0.0.1:3457", state: "running" }),
    handleBillingUsageSync: async () => {}, handleRawTraceSync: async () => {}, requestRuntimeConfigReload: () => {},
    replayContextArchive: async () => ({ ok: false, statusCode: 404, message: "disabled" }),
    proxyRequest: async () => { throw new Error("Counting must not enter the inference proxy."); }
  });
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(request, { headers, method: "POST", url: "/v1/messages/count_tokens" });
  const response = new Capture();
  await handler.handleRequest(request, response);
  return response;
}

test("both count endpoints send mapped Bailian requests with upstream credentials", async (t) => {
  const calls = [];
  const upstreamBody = '{ "input_tokens": 261, "future": "kept" }';
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    return new Response(upstreamBody, { headers: {
      "content-type": "application/json", "x-request-id": "count-id", "content-length": "123", "content-encoding": "gzip"
    } });
  });
  for (const mode of ["single", "wrapper"]) {
    const result = await invoke(mode, configFor());
    assert.equal(result.statusCode, 200);
    assert.equal(result.text(), upstreamBody);
    assert.equal(result.headers["x-request-id"], "count-id");
    assert.equal(result.headers["content-length"], undefined);
    assert.equal(result.headers["content-encoding"], undefined);
  }
  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    assert.equal(url, "https://ws-test.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages/count_tokens");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    assert.deepEqual(JSON.parse(init.body), { ...payload, model: "qwen3.7-plus" });
    assert.equal(init.headers["x-api-key"], "provider-key");
    assert.equal(init.headers["anthropic-beta"], "future-feature");
    assert.equal(init.headers["x-client-custom"], "preserve");
    for (const name of ["authorization", "cookie", "x-auth-api-key-id", "x-ccr-routed-model"]) assert.equal(init.headers[name], undefined, name);
  }
  assert.equal(payload.model, "claude-count-alias");
});

test("Bailian counting normalizes supported endpoint forms and rejects host lookalikes", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => { calls.push(url); return Response.json({ input_tokens: 11 }); });
  for (const base of [
    "https://dashscope.aliyuncs.com/apps/anthropic", "https://dashscope-intl.aliyuncs.com/apps/anthropic",
    "https://coding.dashscope.aliyuncs.com/apps/anthropic", "https://cn-hongkong.dashscope.aliyuncs.com/apps/anthropic",
    "https://ws-test.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
  ]) {
    const result = await invoke("single", configFor(base));
    assert.equal(JSON.parse(result.text()).input_tokens, 11, base);
    assert.ok(calls.at(-1).endsWith("/apps/anthropic/v1/messages/count_tokens"));
    assert.ok(!calls.at(-1).includes("/v1/v1/"));
  }
  for (const base of [
    "http://dashscope.aliyuncs.com/apps/anthropic", "https://dashscope.aliyuncs.com.evil.test/apps/anthropic",
    "https://evilmaas.aliyuncs.com/apps/anthropic", "https://api.example.com/apps/anthropic",
    "https://dashscope.aliyuncs.com/compatible-mode/v1"
  ]) assert.equal(isBailianAnthropicBaseUrl(base), false, base);
  const legacyConfig = configFor();
  delete legacyConfig.Providers[0].capabilities;
  legacyConfig.Providers[0].type = "anthropic_messages";
  legacyConfig.Providers[0].api_base_url = "https://dashscope.aliyuncs.com/apps/anthropic";
  assert.equal(JSON.parse((await invoke("single", legacyConfig)).text()).input_tokens, 11);
});

test("non-Bailian and OpenAI-only providers retain local estimation", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Must stay local"); });
  for (const mode of ["single", "wrapper"]) {
    const config = configFor("https://api.example.com/anthropic");
    assert.equal(typeof JSON.parse((await invoke(mode, config)).text()).input_tokens, "number");
    config.Providers[0].capabilities = [{ type: "openai_chat_completions", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }];
    assert.equal(typeof JSON.parse((await invoke(mode, config)).text()).input_tokens, "number");
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("counting respects the enabled credential pool and explicit upstream headers", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => { calls.push(init); return Response.json({ input_tokens: 9 }); });
  const config = configFor();
  config.Providers[0].credentials = [
    { id: "disabled", enabled: false, api_key: "disabled-key", priority: 0 },
    { id: "secondary", api_key: "second-key", priority: 2 },
    { id: "primary", api_key: "first-key", priority: 1 }
  ];
  config.Providers[0].extraHeaders = { "x-provider-option": "configured" };
  await invoke("single", config);
  assert.equal(calls[0].headers["x-api-key"], "first-key");
  assert.equal(calls[0].headers["x-provider-option"], "configured");
  delete config.Providers[0].api_key;
  config.Providers[0].credentials = [{ enabled: false, api_key: "disabled-key" }];
  assert.equal((await invoke("single", config)).statusCode, 503);
  assert.equal(calls.length, 1);
});

test("both entry points preserve upstream failures instead of estimating", async (t) => {
  let status = 429;
  t.mock.method(globalThis, "fetch", async () => new Response('{"error":{"message":"upstream failure"}}', {
    status, headers: { "content-type": "application/json", "retry-after": "7" }
  }));
  for (const mode of ["single", "wrapper"]) {
    for (status of [400, 401, 403, 404, 429, 500, 307]) {
      const result = await invoke(mode, configFor());
      assert.equal(result.statusCode, status);
      assert.equal(result.headers["retry-after"], "7");
      assert.equal(result.text(), '{"error":{"message":"upstream failure"}}');
    }
  }
});

test("malformed, oversized, and failed count responses never become local counts", async (t) => {
  let reply;
  t.mock.method(globalThis, "fetch", async () => { if (reply instanceof Error) throw reply; return reply; });
  for (const body of ['not json', '{}', '{"input_tokens":-1}', '{"input_tokens":1.5}', 'x'.repeat(1024 * 1024 + 1)]) {
    reply = new Response(body);
    assert.equal((await invoke("single", configFor())).statusCode, 502);
  }
  reply = new Error("private-provider-key must not leak");
  const result = await invoke("single", configFor());
  assert.equal(result.statusCode, 502);
  assert.ok(!result.text().includes("private-provider-key"));
});

test("client disconnect aborts the upstream count and removes listeners", async (t) => {
  const response = new EventEmitter();
  response.writableEnded = false;
  const request = new EventEmitter();
  t.mock.method(globalThis, "fetch", async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    response.emit("close");
  }));
  const config = configFor();
  const result = await forwardBailianCountTokens({ config, router: new ClaudeCodeRouterPlugin(config), body: payload, headers: requestHeaders(), request, response });
  assert.equal(result.statusCode, 499);
  assert.equal(request.listenerCount("aborted"), 0);
  assert.equal(response.listenerCount("close"), 0);
});

test("token counting has a bounded timeout and accepts a zero token result", async (t) => {
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", () => timeout(10));
  const fetch = t.mock.method(globalThis, "fetch", async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  // Keep the event loop alive while the unref'ed AbortSignal timer expires.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    assert.equal((await invoke("single", configFor())).statusCode, 504);
  } finally { clearTimeout(keepAlive); }
  fetch.mock.mockImplementation(async () => Response.json({ input_tokens: 0 }));
  assert.equal(JSON.parse((await invoke("single", configFor())).text()).input_tokens, 0);
});

test("unrelated providers do not execute inference routing for local estimates", async () => {
  const result = await forwardBailianCountTokens({
    config: configFor("https://api.example.com/anthropic"), body: payload, headers: requestHeaders(),
    router: { routeRequest: async () => { throw new Error("Unexpected inference routing"); } }
  });
  assert.equal(result, undefined);
});

test("profile restrictions reject count requests before reaching Bailian", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Must not reach upstream"); });
  for (const mode of ["single", "wrapper"]) {
    const config = configFor();
    config.APIKEYS[0].id = "profile:restricted";
    config.profile.profiles = [{ id: "restricted", enabled: true, agent: "claude-code", model: "other/model", availableModels: ["other/model"], scope: "ccr" }];
    const result = await invoke(mode, config);
    assert.equal(result.statusCode, 403);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("Claude tier aliases and dated snapshots count the mapped Bailian model in both runtimes", async (t) => {
  const models = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    models.push(JSON.parse(init.body).model);
    return Response.json({ input_tokens: 261 });
  });
  const config = configFor();
  config.APIKEYS[0].id = "profile:tiers";
  config.Router.rules = [];
  config.profile.profiles = [{
    id: "tiers", enabled: true, agent: "claude-code", name: "Tiers", scope: "ccr",
    claudeDefaultModelList: true, model: "bailian/qwen3.7-plus", sonnetModel: "bailian/qwen3.7-plus",
    availableModels: ["bailian/qwen3.7-plus"], routing: { enabled: false, enhancedRoute: false, rules: [] }
  }];
  for (const mode of ["single", "wrapper"]) {
    for (const model of ["claude-sonnet-5", "claude-sonnet-5[1m]", "claude-sonnet-5-20260923[1m]"]) {
      const result = await invoke(mode, config, { ...payload, model });
      assert.equal(result.statusCode, 200);
      assert.equal(JSON.parse(result.text()).input_tokens, 261);
    }
  }
  assert.deepEqual(models, Array(6).fill("qwen3.7-plus"));
});
