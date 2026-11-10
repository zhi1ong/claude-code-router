import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { before } from "node:test";

let createDefaultAppConfig, gatewayService, bailianEnhancedSearchEndpointEnv;
let requestLogRuntime, flushRequestLogRuntime, closeRequestLogRuntime;
let applyProfileRuntimeConfig;
before(async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ccr-kimi-client-search-http-"));
  process.env.CCR_INTERNAL_HOME_DIR = path.join(root, "home");
  process.env.CCR_INTERNAL_APP_DATA_DIR = path.join(root, "app-data");
  process.env.CCR_INTERNAL_USER_DATA_DIR = path.join(root, "user-data");
  process.env.KIMI_CODE_HOME = path.join(root, "source-kimi");
  ({ createDefaultAppConfig } = await import("@ccr/core/config/default-config.ts"));
  ({ gatewayService } = await import("@ccr/core/gateway/service.ts"));
  ({ bailianEnhancedSearchEndpointEnv } = await import("@ccr/core/gateway/features/bailian-enhanced-search/mcp.ts"));
  ({ applyProfileRuntimeConfig } = await import("@ccr/core/profiles/service.ts"));
  ({ requestLogRuntime, flushRequestLogRuntime, closeRequestLogRuntime } = await import("@ccr/core/observability/request-log-store.ts"));
  requestLogRuntime.options.workerFile = path.resolve(__dirname, "../../../runtime/request-log-worker.js");
});

test("Kimi and DSH client search follow the authenticated default through the real HTTP pipeline", { timeout: 30000 }, async (t) => {
  const modelCalls = [];
  const bailianCalls = [];
  const kimiCalls = [];
  let kimiFailure = 0;
  const hangingStarted = Promise.withResolvers();
  const hangingClosed = Promise.withResolvers();
  const model = createServer(async (request, response) => {
    modelCalls.push({ path: request.url, body: await readJson(request) });
    sendJson(response, 500, { error: { message: "search must not call a model" } });
  });
  const bailian = createServer(async (request, response) => {
    const body = await readJson(request);
    bailianCalls.push({ body, authorization: request.headers.authorization });
    if (body.method === "notifications/initialized") { response.writeHead(202); response.end(); return; }
    sendJson(response, 200, { id: body.id, jsonrpc: "2.0", result: body.method === "initialize" ? {} : {
      content: [{ type: "text", text: JSON.stringify({ pages: [
        { title: "Bailian", url: "https://example.test/bailian", snippet: "Bailian evidence" }
      ] }) }]
    } });
  });
  const kimi = createServer(async (request, response) => {
    const body = await readJson(request);
    kimiCalls.push({ path: request.url, headers: request.headers, body });
    if (body.text_query === "hang") {
      response.once("close", hangingClosed.resolve);
      hangingStarted.resolve();
      return;
    }
    sendJson(response, kimiFailure || 200, kimiFailure ? { error: { message: "private upstream detail" } } : {
      search_results: [{ title: "Kimi", url: "https://example.test/kimi", snippet: "Kimi evidence" }]
    });
  });
  const previousEntry = process.env.CCR_GATEWAY_ENTRY;
  const previousEndpoint = process.env[bailianEnhancedSearchEndpointEnv];
  t.after(async () => {
    await gatewayService.stop();
    await Promise.all([close(model), close(bailian), close(kimi)]);
    await closeRequestLogRuntime();
    for (const [key, value] of [["CCR_GATEWAY_ENTRY", previousEntry], [bailianEnhancedSearchEndpointEnv, previousEndpoint]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  await Promise.all([listen(model), listen(bailian), listen(kimi)]);
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input, init) => realFetch(String(input) === "https://api.kimi.com/coding/v1/search"
    ? url(kimi) + "/coding/v1/search" : input, init));
  process.env.CCR_GATEWAY_ENTRY = createRequire(path.join(process.cwd(), "package.json")).resolve("@the-next-ai/ai-gateway");
  process.env[bailianEnhancedSearchEndpointEnv] = url(bailian) + "/mcp";
  let config = createDefaultAppConfig();
  config.APIKEY = "general-key";
  config.APIKEYS = [{ id: "general", key: "general-key", createdAt: new Date(0).toISOString() }];
  const defaultModels = { bailian: "Selected/kimi-for-coding", official: "Kimi/kimi-for-coding",
    alias: "Fusion/default-search", unsupported: "Other/model", missing: "Missing/model", empty: "", limited: "Selected/kimi-for-coding",
    cc: "Kimi/kimi-for-coding" };
  config.profile.profiles = Object.entries(defaultModels).map(([id, model]) => ({
    id, name: id, agent: id === "cc" ? "claude-code" : "kimi", enabled: true, scope: "ccr", model,
    availableModels: ["Selected/kimi-for-coding", "Kimi/kimi-for-coding", "Other/model"]
  }));
  config.APIKEYS.push(...Object.keys(defaultModels).map(id => ({ id: `profile:${id}`, key: `key-${id}`,
    createdAt: new Date(0).toISOString(), ...(id === "limited" ? { limits: { maxRequests: 1, windowMs: 60000 } } : {}) })));
  config.gateway = { enabled: true, host: "127.0.0.1", coreHost: "127.0.0.1", port: await freePort(), corePort: await freePort() };
  config.proxy.upstream.mode = "none";
  config.Router.builtInRules = { "claude-code": { enabled: false }, codex: { enabled: false } };
  config.Router.fallback = { mode: "off", models: [], retryCount: 0 };
  config.observability.requestLogs = true;
  config.observability.requestLogSuccessSampleRate = 1;
  config.Providers = ["First", "Selected"].map(name => ({ id: name.toLowerCase(), name, models: ["kimi-for-coding"],
    api_key: "model-key", capabilities: [{ type: "anthropic_messages", baseUrl: url(model) }],
    enhancedSearch: { enabled: true, apiKey: "search-" + name } }));
  config.Providers.push({ id: "kimi", name: "Kimi", models: ["kimi-for-coding"],
    capabilities: [{ type: "openai_chat_completions", baseUrl: "https://api.kimi.com/coding/v1" }],
    credentials: [{ id: "primary", api_key: "primary-kimi-key", priority: 1 },
      { id: "secondary", api_key: "secondary-kimi-key", priority: 2 }] });
  config.Providers.push({ id: "other", name: "Other", models: ["model"], api_key: "other-key",
    capabilities: [{ type: "openai_chat_completions", baseUrl: url(model) + "/v1" }] });
  config.virtualModelProfiles = [{ enabled: true, match: { exactAliases: ["default-search"] },
    baseModel: { mode: "fixed", fixedModel: "Selected/kimi-for-coding" },
    materialization: { enabled: true, includeInGatewayModels: true } }];
  let status = await gatewayService.start(config);
  assert.equal(status.state, "running", status.lastError);
  assert.notEqual(status.endpoint, status.coreEndpoint);
  const wrapper = applyProfileRuntimeConfig(config, {
    ...config.profile.profiles.find(profile => profile.id === "bailian"),
    env: { CCR_KIMI_BIN: process.execPath, KIMI_WEB_SEARCH_BASE_URL: "http://127.0.0.1:1/stale-profile-search",
      KIMI_WEB_SEARCH_API_KEY: "stale-profile-key" }
  }, "key-bailian");
  assert.equal(wrapper.ok, true, wrapper.message);
  const clientFile = path.join(process.env.CCR_INTERNAL_HOME_DIR, "search-client.mjs");
  writeFileSync(clientFile, `
    const response = await fetch(process.env.KIMI_WEB_SEARCH_BASE_URL, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + process.env.KIMI_WEB_SEARCH_API_KEY },
      body: JSON.stringify({ text_query: "Shanghai weather", model: "Other/model" }), signal: AbortSignal.timeout(5000)
    });
    console.log(JSON.stringify({ status: response.status, text: await response.text(), url: process.env.KIMI_WEB_SEARCH_BASE_URL }));
  `);

  async function post(route, body, key = "key-bailian", options = {}) {
    const response = await fetch(status.endpoint + route, { method: "POST", headers: {
      authorization: `Bearer ${key}`, "content-type": "application/json", "x-ccr-client": "kimi",
      "x-ccr-profile": "official", "x-target-provider": "kimi", "x-ccr-routed-model": "Kimi/kimi-for-coding",
      cookie: "private-client-cookie", "x-msh-test": "private-client-header"
    }, body: typeof body === "string" ? body : JSON.stringify(body), signal: options.signal ?? AbortSignal.timeout(5000) });
    return { status: response.status, text: await response.text() };
  }
  const query = { text_query: "Shanghai weather", model: "Other/model" };
  for (const [route, key] of [["/v1/search", "key-bailian"], ["/search", "key-alias"]]) {
    const result = route === "/v1/search" ? await runSearchClient(wrapper.path, clientFile) : await post(route, query, key);
    if (route === "/v1/search") assert.equal(result.url, status.endpoint + "/v1/search");
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(JSON.parse(result.text), { search_results: [
      { title: "Bailian", url: "https://example.test/bailian", snippet: "Bailian evidence" }
    ] });
  }
  assert.equal(bailianCalls.length, 6);
  assert.ok(bailianCalls.every(call => call.authorization === "Bearer search-Selected"));
  assert.equal(bailianCalls.at(-1).body.params.arguments.query, query.text_query);
  assert.equal(kimiCalls.length, 0, "client-supplied model/provider/profile headers cannot override the default");
  const official = await post("/v1/search/", query, "key-official");
  assert.equal(official.status, 200, official.text);
  assert.match(official.text, /Kimi evidence/);
  assert.equal(kimiCalls.length, 1);
  const upstream = kimiCalls[0];
  assert.deepEqual(upstream.body, { text_query: query.text_query });
  assert.equal(upstream.path, "/coding/v1/search");
  assert.equal(upstream.headers.authorization, "Bearer primary-kimi-key");
  for (const header of ["x-api-key", "cookie", "x-msh-test", "x-ccr-profile", "x-target-provider"]) {
    assert.equal(upstream.headers[header], undefined);
  }
  assert.match(upstream.headers["user-agent"], /^kimi-code-cli\//);
  await flushRequestLogRuntime(2000);
  const rows = (await requestLogRuntime.list({ pageSize: 100 })).items;
  assert.ok(rows.some(row => row.provider === "Selected" && row.resolvedModel === "Selected/kimi-for-coding"), JSON.stringify(rows));
  assert.ok(rows.some(row => row.provider === "Kimi" && row.resolvedModel === "Kimi/kimi-for-coding"), JSON.stringify(rows));

  for (const [key, expected] of [["invalid-key", 401], ["general-key", 503], ["key-cc", 503],
    ["key-unsupported", 503], ["key-missing", 503], ["key-empty", 503]]) {
    assert.equal((await post("/v1/search", query, key)).status, expected);
  }
  for (const invalid of ["", "invalid JSON", "{}", '{"text_query":" "}']) {
    assert.equal((await post("/v1/search", invalid)).status, 400);
  }
  assert.equal(bailianCalls.length, 6);
  assert.equal(kimiCalls.length, 1);
  assert.equal((await post("/v1/search", query, "key-limited")).status, 200);
  assert.equal((await post("/v1/search", query, "key-limited")).status, 429);
  assert.equal(bailianCalls.length, 9, "the rate-limited request cannot reach EnhancedSearch");

  const dshQuery = { query: "Shanghai weather", count: 10, need_content: false, ori_question: "Shanghai weather?" };
  const dsh = await post("/v1/tools/search", dshQuery, "key-bailian");
  assert.equal(dsh.status, 200, dsh.text);
  assert.deepEqual(JSON.parse(dsh.text), { results: [
    { url: "https://example.test/bailian", title: "Bailian", snippet: "Bailian evidence", date: null }
  ] });
  assert.equal(bailianCalls.length, 12);
  assert.equal(bailianCalls.at(-1).authorization, "Bearer search-Selected");
  assert.equal(bailianCalls.at(-1).body.params.arguments.query, dshQuery.query);
  const dshClaudeProfile = await post("/tools/search", dshQuery, "key-cc");
  assert.equal(dshClaudeProfile.status, 200, dshClaudeProfile.text);
  assert.match(dshClaudeProfile.text, /Kimi evidence/);
  assert.equal(kimiCalls.length, 2);
  for (const [key, expected] of [["invalid-key", 401], ["general-key", 503], ["key-unsupported", 503]]) {
    assert.equal((await post("/v1/tools/search", dshQuery, key)).status, expected);
  }
  assert.equal((await post("/v1/tools/search", { text_query: "Shanghai weather" })).status, 400);
  assert.equal(bailianCalls.length, 12);
  assert.equal(kimiCalls.length, 2);

  const controller = new AbortController();
  const pending = post("/v1/search", { text_query: "hang" }, "key-official", { signal: controller.signal });
  await hangingStarted.promise;
  controller.abort(new Error("client cancelled search"));
  await assert.rejects(pending, /client cancelled search/);
  await hangingClosed.promise;

  kimiFailure = 401;
  const failed = await post("/v1/search", query, "key-official");
  assert.equal(failed.status, 502, failed.text);
  assert.doesNotMatch(failed.text, /private upstream|primary-kimi-key/);
  kimiFailure = 0;
  const cc = await post("/v1/messages", { model: "Other/model", messages: [{ role: "user",
    content: "Perform a web search for the query: Shanghai weather" }],
    tools: [{ name: "web_search", type: "web_search_20250305" }] }, "key-cc");
  assert.equal(cc.status, 200, cc.text);
  assert.match(cc.text, /Kimi evidence/);
  assert.equal(kimiCalls.at(-1).headers.authorization, "Bearer secondary-kimi-key", "CC and Kimi share search-only cooldowns");
  assert.equal(modelCalls.length, 0);

  config = structuredClone(config);
  config.Providers = config.Providers.filter(provider => provider.id === "kimi");
  status = await gatewayService.start(config);
  assert.equal(status.state, "running", status.lastError);
  assert.notEqual(status.endpoint, status.coreEndpoint, "Kimi-only configurations retain the client bridge");
  assert.equal((await post("/v1/search", query, "key-official")).status, 200);
  config = structuredClone(config);
  config.Providers = [{ id: "other", name: "Other", models: ["model"], api_key: "other-key",
    capabilities: [{ type: "openai_chat_completions", baseUrl: url(model) + "/v1" }] }];
  status = await gatewayService.start(config);
  assert.equal(status.state, "running", status.lastError);
  assert.notEqual(status.endpoint, status.coreEndpoint, "an unsupported default is rejected through the CCR pipeline");
  assert.equal((await post("/v1/search", query, "key-unsupported")).status, 503);
  assert.equal((await post("/v1/tools/search", { query: "Shanghai weather" }, "key-unsupported")).status, 503);
  assert.equal(modelCalls.length, 0, "unsupported defaults never forward /search to an arbitrary model endpoint");
});

function runSearchClient(wrapperFile, clientFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      process.platform === "win32" ? ["/d", "/c", wrapperFile, clientFile] : [wrapperFile, clientFile], {
        env: { ...process.env, KIMI_WEB_SEARCH_BASE_URL: "http://127.0.0.1:1/stale-inherited-search",
          KIMI_WEB_SEARCH_API_KEY: "stale-inherited-key" }, timeout: 10000
      });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => {
      if (code !== 0) { reject(new Error(`Search client exited with ${code}: ${stderr}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body));
}
function listen(server) {
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
}
function url(server) { return "http://127.0.0.1:" + server.address().port; }
function close(server) {
  if (!server.listening) return Promise.resolve();
  server.closeAllConnections(); return new Promise(resolve => server.close(resolve));
}
async function freePort() {
  const server = createServer(); await listen(server); const port = server.address().port; await close(server); return port;
}
