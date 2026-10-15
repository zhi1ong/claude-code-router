import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import test, { before } from "node:test";
import { tmpdir } from "node:os";
let createDefaultAppConfig, gatewayService, bailianEnhancedSearchEndpointEnv;
before(async () => {
  const root = path.join(process.env.CCR_INTERNAL_HOME_DIR || tmpdir(), "bailian-http-" + process.pid);
  process.env.CCR_INTERNAL_HOME_DIR = path.join(root, "home");
  process.env.CCR_INTERNAL_APP_DATA_DIR = path.join(root, "app-data");
  process.env.CCR_INTERNAL_USER_DATA_DIR = path.join(root, "user-data");
  ({ createDefaultAppConfig } = await import("@ccr/core/config/default-config.ts"));
  ({ gatewayService } = await import("@ccr/core/gateway/service.ts"));
  ({ bailianEnhancedSearchEndpointEnv } = await import("@ccr/core/gateway/features/bailian-enhanced-search/mcp.ts"));
});

test("real gateway routes Claude Code searches through Bailian or Kimi according to the selected provider", { timeout: 30000 }, async (t) => {
  const models = [];
  const searches = [];
  const kimiSearches = [];
  const upstream = createServer(async (request, response) => {
    const body = await readJson(request);
    models.push(body);
    sendJson(response, 200, { id: "msg_model", type: "message", role: "assistant", model: body.model,
      content: [{ type: "text", text: "normal answer" }], stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const search = createServer(async (request, response) => {
    const body = await readJson(request);
    searches.push({ body, authorization: request.headers.authorization });
    if (body.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
      return;
    }
    const result = body.method === "initialize" ? {} : {
      content: [{ type: "text", text: JSON.stringify({ pages: [
        { title: "Weather", url: "https://example.test/weather", snippet: "Sunny" },
        { title: "Other", url: "https://notexample.test/weather" }
      ] }) }]
    };
    sendJson(response, 200, { id: body.id, jsonrpc: "2.0", result });
  });
  const kimiSearch = createServer(async (request, response) => {
    kimiSearches.push({ path: request.url, headers: request.headers, body: await readJson(request) });
    sendJson(response, 200, { search_results: [
      { title: "Kimi weather", url: "https://example.test/weather", snippet: "Sunny from Kimi" },
      { title: "Other", url: "https://notexample.test/weather" }
    ] });
  });
  const previousEntry = process.env.CCR_GATEWAY_ENTRY;
  const previousEndpoint = process.env[bailianEnhancedSearchEndpointEnv];
  t.after(async () => {
    await gatewayService.stop();
    await Promise.all([close(upstream), close(search), close(kimiSearch)]);
    for (const [key, value] of [["CCR_GATEWAY_ENTRY", previousEntry], [bailianEnhancedSearchEndpointEnv, previousEndpoint]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  await Promise.all([listen(upstream), listen(search), listen(kimiSearch)]);
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input, init) => {
    const target = String(input);
    return realFetch(target === "https://api.kimi.com/coding/v1/search"
      ? url(kimiSearch) + "/coding/v1/search" : input, init);
  });
  process.env.CCR_GATEWAY_ENTRY = createRequire(path.join(process.cwd(), "package.json")).resolve("@the-next-ai/ai-gateway");
  process.env[bailianEnhancedSearchEndpointEnv] = url(search) + "/mcp";
  const config = createDefaultAppConfig();
  config.APIKEY = "client-key";
  config.APIKEYS = [{ id: "client", key: "client-key", createdAt: new Date(0).toISOString() },
    { id: "profile:restricted", key: "restricted-key", createdAt: new Date(0).toISOString() },
    { id: "profile:kimi", key: "kimi-profile-key", createdAt: new Date(0).toISOString() },
    { id: "profile:bailian", key: "bailian-profile-key", createdAt: new Date(0).toISOString() }];
  config.profile.profiles = [{ id: "restricted", enabled: true, agent: "claude-code",
    model: "Selected/other", availableModels: ["Selected/other"], scope: "ccr" },
    { id: "kimi", enabled: true, agent: "claude-code", model: "Kimi/kimi-for-coding",
      availableModels: ["Kimi/kimi-for-coding"], scope: "ccr", routing: { enabled: true, enhancedRoute: true, rules: [] } },
    { id: "bailian", enabled: true, agent: "claude-code", model: "Selected/kimi-for-coding",
      availableModels: ["Selected/kimi-for-coding"], scope: "ccr", routing: { enabled: true, enhancedRoute: true, rules: [] } }];
  config.gateway = { enabled: true, host: "127.0.0.1", coreHost: "127.0.0.1", port: await freePort(), corePort: await freePort() };
  config.proxy.upstream.mode = "none";
  config.observability.requestLogs = false;
  config.Router.builtInRules = { "claude-code": { enabled: false }, codex: { enabled: false } };
  config.Router.fallback = { mode: "off", models: [], retryCount: 0 };
  config.Providers = ["First", "Selected"].map(name => ({
    id: name.toLowerCase(), name, models: ["search", "other", "kimi-for-coding"], api_key: "model-key",
    capabilities: [{ type: "anthropic_messages", baseUrl: url(upstream) }],
    enhancedSearch: { enabled: true, apiKey: "search-" + name }
  }));
  config.Providers.push({ id: "kimi-official", name: "Kimi", models: ["kimi-for-coding"], api_key: "kimi-upstream-key",
    capabilities: [{ type: "anthropic_messages", baseUrl: "https://api.kimi.com/coding/" }] });
  const status = await gatewayService.start(config);
  assert.equal(status.state, "running", status.lastError);
  assert.notEqual(status.endpoint, status.coreEndpoint);

  async function post(body, key = "client-key") {
    const response = await fetch(status.endpoint + "/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": key,
        "user-agent": "claude-code/1.0", cookie: "client-private-cookie", "x-msh-test": "client-header" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
    });
    return { status: response.status, text: await response.text(), contentType: response.headers.get("content-type") };
  }
  const ordinary = { model: "Selected/search", max_tokens: 64, messages: [{ role: "user", content: "hello" }] };
  const query = { ...ordinary, messages: [{ role: "user", content: "Perform a web search for the query: Shanghai weather" }],
    tools: [{ type: "web_search_20250305", name: "web_search", allowed_domains: ["example.test"] }] };
  const normal = await post({ ...ordinary, tools: query.tools });
  assert.equal(normal.status, 200, normal.text);
  assert.match(normal.text, /normal answer/);
  assert.equal(models.length, 1);
  assert.equal(searches.length, 0);

  for (const stream of [false, true]) {
    const result = await post({ ...query, stream });
    assert.equal(result.status, 200, result.text);
    assert.match(result.text, /https:\/\/example\.test\/weather/);
    assert.doesNotMatch(result.text, /notexample\.test/);
    if (stream) {
      assert.match(result.contentType, /text\/event-stream/);
      assert.match(result.text, /event: message_stop/);
    } else {
      const message = JSON.parse(result.text);
      assert.equal(message.model, query.model);
      assert.equal(message.content[1].tool_use_id, message.content[0].id);
      assert.equal(message.stop_reason, "end_turn");
    }
  }
  assert.equal(models.length, 1, "dedicated search never calls the model");
  assert.deepEqual(searches.map(item => item.body.method), [
    "initialize", "notifications/initialized", "tools/call", "initialize", "notifications/initialized", "tools/call"
  ]);
  assert.ok(searches.every(item => item.authorization === "Bearer search-Selected"));
  assert.equal(searches.at(-1).body.params.arguments.query, "Shanghai weather");
  for (const [key, expected] of [["invalid-key", 401], ["restricted-key", 403]]) {
    assert.equal((await post(query, key)).status, expected);
    assert.equal(searches.length, 6);
  }
  const kimiQuery = { ...query, model: "Kimi/kimi-for-coding" };
  for (const stream of [false, true]) {
    const result = await post({ ...kimiQuery, stream }, "kimi-profile-key");
    assert.equal(result.status, 200, result.text);
    assert.match(result.text, /Sunny from Kimi/);
    assert.doesNotMatch(result.text, /notexample/);
    if (stream) {
      const events = result.text.split("\n\n").filter(Boolean).map(event => JSON.parse(event.split("\ndata: ")[1]));
      assert.equal(events[0].type, "message_start");
      assert.equal(events[0].message.model, kimiQuery.model);
      assert.equal(events.at(-1).type, "message_stop");
      const blocks = events.filter(event => event.type === "content_block_start").map(event => event.content_block);
      assert.equal(blocks[1].tool_use_id, blocks[0].id);
      assert.equal(events.at(-2).delta.stop_reason, "end_turn");
    } else {
      const message = JSON.parse(result.text);
      assert.equal(message.model, kimiQuery.model);
      assert.equal(message.content[1].tool_use_id, message.content[0].id);
    }
  }
  assert.equal(kimiSearches.length, 2);
  for (const request of kimiSearches) {
    assert.equal(request.path, "/coding/v1/search");
    assert.deepEqual(request.body, { text_query: "Shanghai weather" });
    assert.equal(request.headers.authorization, "Bearer kimi-upstream-key");
    assert.equal(request.headers["x-api-key"], undefined);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers["x-msh-test"], undefined);
  }
  assert.equal(models.length, 1);
  assert.equal(searches.length, 6, "Kimi upstream searches never use Bailian");
  assert.equal((await post({ ...query, model: "Selected/kimi-for-coding" })).status, 200);
  assert.equal(searches.length, 9, "Bailian-hosted Kimi models still use EnhancedSearch");
  assert.equal(kimiSearches.length, 2);
  const profileQuery = { ...query, model: "claude-default" };
  const kimiProfileResult = await post(profileQuery, "kimi-profile-key");
  assert.equal(kimiProfileResult.status, 200, kimiProfileResult.text);
  assert.match(kimiProfileResult.text, /Sunny from Kimi/);
  assert.equal(JSON.parse(kimiProfileResult.text).model, "claude-default");
  assert.equal(kimiSearches.length, 3, "Claude aliases route through the authenticated Kimi profile");
  const bailianProfileResult = await post(profileQuery, "bailian-profile-key");
  assert.equal(bailianProfileResult.status, 200, bailianProfileResult.text);
  assert.equal(searches.length, 12, "the same Claude alias uses EnhancedSearch with the Bailian profile");
  assert.equal(kimiSearches.length, 3);
  for (const [body, key, expected] of [[kimiQuery, "invalid-key", 401], [kimiQuery, "restricted-key", 403],
    [query, "kimi-profile-key", 403]]) {
    assert.equal((await post(body, key)).status, expected);
  }
  assert.equal(kimiSearches.length, 3, "authentication and profile allowlists are checked before search");

  config.Providers = config.Providers.filter(provider => provider.id === "kimi-official");
  const kimiOnlyStatus = await gatewayService.start(config);
  assert.equal(kimiOnlyStatus.state, "running", kimiOnlyStatus.lastError);
  assert.notEqual(kimiOnlyStatus.endpoint, kimiOnlyStatus.coreEndpoint, "Kimi-only configurations must retain the CCR search pipeline");
  const kimiOnlyResult = await post({ ...profileQuery, stream: true }, "kimi-profile-key");
  assert.equal(kimiOnlyResult.status, 200, kimiOnlyResult.text);
  assert.match(kimiOnlyResult.text, /Sunny from Kimi/);
  assert.match(kimiOnlyResult.text, /event: message_stop/);
  assert.equal(kimiSearches.length, 4);
  assert.equal(searches.length, 12, "Kimi-only configurations never invoke Bailian");
});

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
function listen(server) {
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
}
function url(server) { return "http://127.0.0.1:" + server.address().port; }
function close(server) {
  if (!server.listening) return Promise.resolve();
  server.closeAllConnections();
  return new Promise(resolve => server.close(resolve));
}
async function freePort() {
  const server = createServer();
  await listen(server);
  const port = server.address().port;
  await close(server);
  return port;
}
