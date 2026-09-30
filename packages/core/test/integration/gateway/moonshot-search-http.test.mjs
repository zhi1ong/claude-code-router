import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import { applyProfileConfig } from "@ccr/core/profiles/service.ts";
import { CONFIGDIR } from "@ccr/core/config/constants.ts";
import { gatewayService } from "@ccr/core/gateway/service.ts";
import { bailianEnhancedSearchEndpointEnv } from "@ccr/core/gateway/features/bailian-enhanced-search/mcp.ts";
import { closeRequestLogRuntime, flushRequestLogRuntime, getRequestLogDetail, getRequestLogs, requestLogRuntime } from "@ccr/core/observability/request-log-store.ts";

const gatewayKey = "moonshot-search-gateway-key";

test("moonshot_search serves the Kimi CLI search protocol end to end", { timeout: 90_000 }, async (t) => {
  const searchRequests = [];
  const upstream = createServer((request, response) => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "the model upstream must not see search traffic" } }));
  });
  const search = createServer((request, response) => {
    void readJson(request).then((body) => {
      searchRequests.push({ authorization: request.headers.authorization, body });
      if (body.method === "notifications/initialized") {
        response.writeHead(202);
        response.end();
        return;
      }
      const result = body.method === "initialize"
        ? { capabilities: { tools: {} }, protocolVersion: "2024-11-05", serverInfo: { name: "local-search", version: "1" } }
        : { content: [{ type: "text", text: JSON.stringify({ pages: [{
            title: "Local search result", url: "https://example.test/result", snippet: "Search worked."
          }] }) }] };
      sendJson(response, 200, { id: body.id, jsonrpc: "2.0", result });
    }).catch((error) => sendJson(response, 500, { error: String(error) }));
  });
  const previousEntry = process.env.CCR_GATEWAY_ENTRY;
  const previousEndpoint = process.env[bailianEnhancedSearchEndpointEnv];
  const previousWorkerFile = requestLogRuntime.options.workerFile;

  try {
    await listen(upstream);
    await listen(search);
    const requireFromProject = createRequire(path.join(process.cwd(), "package.json"));
    process.env.CCR_GATEWAY_ENTRY = requireFromProject.resolve("@the-next-ai/ai-gateway");
    process.env[bailianEnhancedSearchEndpointEnv] = `${serverUrl(search)}/mcp`;
    requestLogRuntime.options.workerFile = path.join(process.cwd(), ".test-dist", "core", "runtime", "request-log-worker.js");
    let config = testConfig(serverUrl(upstream), await availablePort(), await availablePort());
    config.observability.requestLogs = true;
    const initialStatus = await gatewayService.start(config);
    assert.equal(initialStatus.state, "running", initialStatus.lastError);
    assert.equal(initialStatus.coreEndpoint, initialStatus.endpoint);

    await t.test("disabled search cannot call MCP", async () => {
      const result = await postSearch({ text_query: "Shanghai weather" });
      assert.notEqual(result.status, 200);
      assert.equal(searchRequests.length, 0);
    });

    await t.test("a generated Kimi wrapper reaches /v1/search with its own API key", async () => {
      config = structuredClone(config);
      config.Providers[0].enhancedSearch.enabled = true;
      config.profile.profiles = [{
        agent: "kimi",
        availableModels: ["Selected Bailian/search-model"],
        enabled: true,
        env: {
          CCR_KIMI_BIN: process.execPath,
          KIMI_WEB_SEARCH_BASE_URL: "http://127.0.0.1:1/profile-search",
          KIMI_WEB_SEARCH_API_KEY: "old-profile-search-key"
        },
        id: "kimi-search-e2e",
        model: "Selected Bailian/search-model",
        name: "Kimi Search E2E",
        scope: "ccr",
        surface: "cli"
      }];
      const applyResult = await applyProfileConfig(config);
      const kimiClient = applyResult.clients.find((client) => client.client === "kimi");
      assert.ok(kimiClient?.ok, kimiClient?.message);
      // applyProfileConfig adds the wrapper's API key to config.APIKEYS.
      await gatewayService.updateConfig(config);
      const status = gatewayService.getStatus();
      assert.equal(status.state, "running", status.lastError);
      assert.notEqual(status.coreEndpoint, status.endpoint);
      const profileHome = path.join(CONFIGDIR, "profiles", "kimi-search-e2e", "kimi");
      const clientFile = path.join(profileHome, "search-client.mjs");
      writeFileSync(clientFile, `
        const response = await fetch(process.env.KIMI_WEB_SEARCH_BASE_URL, {
          body: JSON.stringify({ text_query: "Shanghai weather" }),
          headers: { authorization: "Bearer " + process.env.KIMI_WEB_SEARCH_API_KEY, "content-type": "application/json" },
          method: "POST",
          signal: AbortSignal.timeout(5000)
        });
        console.log(JSON.stringify({ status: response.status, payload: await response.json(), url: process.env.KIMI_WEB_SEARCH_BASE_URL }));
      `);
      const before = searchRequests.length;
      const wrapperFile = path.join(CONFIGDIR, "bin", `ccr-kimi-cli-wrapper-kimi-search-e2e${process.platform === "win32" ? ".cmd" : ""}`);
      const result = await runSearchClient(wrapperFile, clientFile);
      assert.equal(result.url, `${gatewayService.getStatus().endpoint}/v1/search`);
      assert.equal(result.status, 200, JSON.stringify(result.payload));
      assert.equal(searchRequests.length, before + 3);
      assert.ok(searchRequests.slice(before).every((request) => request.authorization === "Bearer selected-search-key"),
        "the profile search call must resolve through the provider's search key");
      assert.equal(searchRequests.at(-1).body.params.arguments.query, "Shanghai weather");
      assert.deepEqual(result.payload.search_results, [{
        snippet: "Search worked.", title: "Local search result", url: "https://example.test/result"
      }]);

      const entries = await logDetails();
      const entry = entries.find((item) => item.path === "/v1/search" && item.statusCode === 200);
      assert.ok(entry, "the wrapper search must be logged");
      assert.match(entry.requestBody.text, /Shanghai weather/);
      assert.match(JSON.stringify(entry), /enrichment\.moonshot-search/);
      assert.doesNotMatch(JSON.stringify(entry), /selected-search-key/);
    });

    await t.test("unauthorized and invalid requests cannot reach MCP", async () => {
      const before = searchRequests.length;
      const unauthorized = await postSearch({ text_query: "Shanghai weather" }, "invalid-key");
      assert.equal(unauthorized.status, 401, unauthorized.text);
      const invalid = await postSearch({ text_query: "" }, config.APIKEY);
      assert.equal(invalid.status, 400, invalid.text);
      const payload = JSON.parse(invalid.text);
      assert.deepEqual(Object.keys(payload), ["error"]);
      assert.match(payload.error.message, /text_query/);
      assert.equal(searchRequests.length, before);
    });
  } finally {
    await gatewayService.stop();
    await closeRequestLogRuntime();
    requestLogRuntime.options.workerFile = previousWorkerFile;
    await Promise.all([closeServer(upstream), closeServer(search)]);
    restoreEnv("CCR_GATEWAY_ENTRY", previousEntry);
    restoreEnv(bailianEnhancedSearchEndpointEnv, previousEndpoint);
  }
});

function runSearchClient(wrapperFile, clientFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      process.platform === "win32" ? ["/d", "/c", wrapperFile, clientFile] : [wrapperFile, clientFile], {
        env: {
          ...process.env,
          KIMI_WEB_SEARCH_BASE_URL: "http://127.0.0.1:1/inherited-search",
          KIMI_WEB_SEARCH_API_KEY: "old-inherited-search-key"
        }
      });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Search client exited with ${code}: ${stderr}`));
        return;
      }
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
}

function testConfig(upstreamUrl, publicPort, corePort) {
  const config = createDefaultAppConfig();
  config.APIKEY = gatewayKey;
  config.API_TIMEOUT_MS = 5000;
  config.gateway = { coreHost: "127.0.0.1", corePort, enabled: true, host: "127.0.0.1", port: publicPort };
  config.proxy.upstream.mode = "none";
  config.Router.builtInRules["claude-code"].enabled = false;
  config.Router.builtInRules.codex.enabled = false;
  config.Router.fallback = { mode: "off", models: [], retryCount: 0 };
  config.Providers = [{
    api_base_url: `${upstreamUrl}/v1/messages`, api_key: "model-key",
    baseUrl: upstreamUrl, capabilities: [{ baseUrl: upstreamUrl, type: "anthropic_messages" }],
    enhancedSearch: { apiKey: "selected-search-key", enabled: false }, id: "selected",
    models: ["search-model"], name: "Selected Bailian", type: "anthropic_messages"
  }];
  return config;
}

async function postSearch(body, token = gatewayKey) {
  const response = await fetch(`${gatewayService.getStatus().endpoint}/v1/search`, {
    body: JSON.stringify(body), method: "POST", signal: AbortSignal.timeout(5000),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` }
  });
  return { status: response.status, text: await response.text() };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
}

function serverUrl(server) {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function availablePort() {
  const server = createServer();
  await listen(server);
  const port = Number(new URL(serverUrl(server)).port);
  await closeServer(server);
  return port;
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function logDetails() {
  const flushed = await flushRequestLogRuntime(3000);
  assert.equal(flushed.timedOut, false);
  const page = await getRequestLogs({ pageSize: 100, provider: "Selected Bailian" });
  return Promise.all(page.items.map((entry) => getRequestLogDetail({ id: entry.id })));
}
