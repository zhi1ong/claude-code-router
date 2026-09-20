import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import { parseProvidersForTest } from "@ccr/core/config/config.ts";
import {
  bailianEnhancedSearchEndpointEnv,
  normalizeBailianEnhancedSearchQuery,
  searchBailianEnhancedWeb
} from "@ccr/core/gateway/features/bailian-enhanced-search/index.ts";
import {
  applyBailianEnhancedSearchBridgeRequestTransform,
  clearBailianEnhancedSearchBridgeContextsForTest
} from "@ccr/core/gateway/features/bailian-enhanced-search/bridge.ts";
import {
  ccrBailianEnhancedSearchRequestTransformKey,
  ccrBailianEnhancedSearchResponseHookKey,
  ccrBailianEnhancedSearchStreamHookKey
} from "@ccr/core/gateway/core-runtime/router-plugin-contract.ts";
import { createGatewayPlugin } from "@ccr/core/gateway/core-runtime/router-plugin.ts";

const loopbackEndpoint = "http://127.0.0.1/bailian-enhanced-search-mcp";

function mcpSearchResponse(pages) {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    result: {
      content: [{ text: JSON.stringify({ pages }), type: "text" }]
    }
  }), { headers: { "content-type": "application/json" }, status: 200 });
}

function installMcpFetchStub(responses) {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({ body: JSON.parse(String(init?.body ?? "{}")), url: String(input) });
    const next = responses.shift();
    if (!next) {
      throw new Error("Unexpected extra MCP request.");
    }
    return next instanceof Response ? next : new Response(next.body, { headers: { "content-type": "application/json" }, status: next.status });
  };
  return {
    requests,
    restore() {
      globalThis.fetch = previousFetch;
    }
  };
}

function anthropicWebSearchRequestBody() {
  return {
    max_tokens: 1024,
    messages: [{ content: "claude code router latest release notes", role: "user" }],
    model: "Bailian/qwen3.7-max",
    stream: true,
    tools: [{ max_uses: 5, name: "web_search", type: "web_search_20250305" }]
  };
}

function bailianProviderConfig() {
  return createDefaultAppConfig();
}

test("normalizeBailianEnhancedSearchQuery trims, clamps, and rejects short queries", () => {
  assert.equal(normalizeBailianEnhancedSearchQuery("  claude code  "), "claude code");
  assert.equal(normalizeBailianEnhancedSearchQuery("a"), undefined);
  assert.equal(normalizeBailianEnhancedSearchQuery(undefined), undefined);
  assert.equal(normalizeBailianEnhancedSearchQuery("x".repeat(600)).length, 500);
});

test("searchBailianEnhancedWeb performs the MCP handshake and maps pages to results", async () => {
  const previousEndpoint = process.env[bailianEnhancedSearchEndpointEnv];
  process.env[bailianEnhancedSearchEndpointEnv] = loopbackEndpoint;
  const stub = installMcpFetchStub([
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "BaiLianMcpServer", version: "1.0.0" } } }), { headers: { "content-type": "application/json" }, status: 200 }),
    new Response("", { status: 202 }),
    mcpSearchResponse([
      { hostname: "example.test", snippet: "Release notes snippet", title: "Release notes", url: "https://example.test/release" },
      { hostname: "empty.test", snippet: "", title: "", url: "" }
    ])
  ]);
  try {
    const results = await searchBailianEnhancedWeb({ apiKey: "sk-ws-test", query: "claude code router", timeoutMs: 5_000 });
    assert.deepEqual(results, [
      { snippet: "Release notes snippet", title: "Release notes", url: "https://example.test/release" }
    ]);
    assert.equal(stub.requests.length, 3);
    assert.equal(stub.requests[0].body.method, "initialize");
    assert.equal(stub.requests[1].body.method, "notifications/initialized");
    assert.equal(stub.requests[2].body.method, "tools/call");
    assert.equal(stub.requests[2].body.params.name, "search_pro");
    assert.equal(stub.requests[2].body.params.arguments.query, "claude code router");
  } finally {
    stub.restore();
    if (previousEndpoint === undefined) {
      delete process.env[bailianEnhancedSearchEndpointEnv];
    } else {
      process.env[bailianEnhancedSearchEndpointEnv] = previousEndpoint;
    }
  }
});

test("searchBailianEnhancedWeb retries once after an empty response", async () => {
  const previousEndpoint = process.env[bailianEnhancedSearchEndpointEnv];
  process.env[bailianEnhancedSearchEndpointEnv] = loopbackEndpoint;
  const stub = installMcpFetchStub([
    { body: "", status: 200 },
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json" }, status: 200 }),
    new Response("", { status: 202 }),
    mcpSearchResponse([{ title: "Retry result", url: "https://example.test/retry" }])
  ]);
  try {
    const results = await searchBailianEnhancedWeb({ apiKey: "sk-ws-test", query: "retry query", timeoutMs: 5_000 });
    assert.equal(results.length, 1);
    assert.equal(results[0].title, "Retry result");
    assert.equal(stub.requests.length, 4);
  } finally {
    stub.restore();
    if (previousEndpoint === undefined) {
      delete process.env[bailianEnhancedSearchEndpointEnv];
    } else {
      process.env[bailianEnhancedSearchEndpointEnv] = previousEndpoint;
    }
  }
});

test("CCR router core plugin bridges Bailian web_search requests end to end", async () => {
  const previousEndpoint = process.env[bailianEnhancedSearchEndpointEnv];
  process.env[bailianEnhancedSearchEndpointEnv] = loopbackEndpoint;
  const stub = installMcpFetchStub([
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json" }, status: 200 }),
    new Response("", { status: 202 }),
    mcpSearchResponse([{ snippet: "Snippet text", title: "Result title", url: "https://example.test/result" }])
  ]);

  const config = bailianProviderConfig();
  config.Providers = [{
    enhancedSearch: { apiKey: "sk-ws-test", enabled: true },
    id: "bailian",
    models: ["qwen3.7-max"],
    name: "Bailian",
    type: "anthropic_messages"
  }];

  try {
    const plugin = await createGatewayPlugin({ plugin: { config: { appConfig: config } } });
    const transform = plugin.requestTransforms.find((item) => item.key === ccrBailianEnhancedSearchRequestTransformKey);
    assert.ok(transform);

    const transformed = await transform.transform({
      request: { headers: {}, id: "bailian-bridge-1", method: "POST", url: "/v1/messages" },
      requestBody: anthropicWebSearchRequestBody(),
      route: { method: "POST", url: "/v1/messages" },
      targetProvider: "bailian::anthropic_messages",
      targetProviderConfig: { name: "bailian::anthropic_messages", type: "anthropic_messages" }
    });

    assert.ok(transformed);
    assert.equal(transformed.headers["x-ccr-bailian-enhanced-search-bridge"], "1");
    assert.equal(transformed.headers["content-type"], "application/json");
    assert.equal(Array.isArray(transformed.requestBody.tools), false);
    const system = transformed.requestBody.system;
    assert.ok(Array.isArray(system));
    const evidenceText = system.at(-1)?.text ?? "";
    assert.match(evidenceText, /web search evidence/i);
    assert.match(evidenceText, /https:\/\/example\.test\/result/);
    // Thinking and effort stay untouched: the bridge only swaps the tool for evidence.
    assert.equal(transformed.requestBody.thinking, undefined);
    assert.equal(transformed.requestBody.output_config, undefined);

    const responseHook = plugin.responseHooks.find((item) => item.key === ccrBailianEnhancedSearchResponseHookKey);
    const response = responseHook.transformResponse({
      request: { headers: {}, id: "bailian-bridge-1", method: "POST", url: "/v1/messages" },
      responsePayload: {
        content: [{ text: "The answer.", type: "text" }],
        model: "qwen3.7-max",
        role: "assistant",
        stop_reason: "end_turn",
        type: "message"
      },
      responseHeaders: {},
      statusCode: 200
    });
    assert.ok(response);
    const content = response.responsePayload.content;
    assert.equal(content[0].type, "server_tool_use");
    assert.equal(content[0].name, "web_search");
    assert.equal(content[1].type, "web_search_tool_result");
    assert.equal(content[1].tool_use_id, content[0].id);
    assert.equal(content.at(-1).type, "text");

    const streamHook = plugin.streamHooks.find((item) => item.key === ccrBailianEnhancedSearchStreamHookKey);
    const sseBody = [
      "event: message_start",
      `data: ${JSON.stringify({ type: "message_start", message: { model: "qwen3.7-max", role: "assistant" } })}`,
      "",
      "event: content_block_start",
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { text: "", type: "text" } })}`,
      "",
      "event: content_block_delta",
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { text: "The answer.", type: "text_delta" } })}`,
      "",
      "event: content_block_stop",
      `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      "",
      "event: message_delta",
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}`,
      "",
      "event: message_stop",
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      ""
    ].join("\n");
    const streamed = await streamHook.transformResponse({
      request: { headers: {}, id: "bailian-bridge-1", method: "POST", url: "/v1/messages" },
      upstreamRequest: { headers: {}, method: "POST", url: "https://bailian.test/apps/anthropic" },
      upstreamResponse: new Response(sseBody, {
        headers: { "content-type": "text/event-stream" },
        status: 200
      })
    });
    assert.ok(streamed);
    assert.equal(streamed.headers.get("content-length"), null);
    const streamText = await streamed.text();
    assert.match(streamText, /"type":"server_tool_use"/);
    assert.match(streamText, /"type":"web_search_tool_result"/);
    assert.match(streamText, /"name":"web_search"/);
    assert.match(streamText, /The answer\./);
  } finally {
    stub.restore();
    clearBailianEnhancedSearchBridgeContextsForTest();
    if (previousEndpoint === undefined) {
      delete process.env[bailianEnhancedSearchEndpointEnv];
    } else {
      process.env[bailianEnhancedSearchEndpointEnv] = previousEndpoint;
    }
  }
});

test("Bailian enhanced search bridge skips requests outside its gates", async (t) => {
  const previousEndpoint = process.env[bailianEnhancedSearchEndpointEnv];
  process.env[bailianEnhancedSearchEndpointEnv] = loopbackEndpoint;

  const disabledConfig = bailianProviderConfig();
  disabledConfig.Providers = [{
    enhancedSearch: { enabled: false },
    id: "bailian",
    models: ["qwen3.7-max"],
    name: "Bailian",
    type: "anthropic_messages"
  }];
  const enabledConfig = bailianProviderConfig();
  enabledConfig.Providers = [{
    enhancedSearch: { apiKey: "sk-ws-test", enabled: true },
    id: "bailian",
    models: ["qwen3.7-max"],
    name: "Bailian",
    type: "anthropic_messages"
  }];

  const plugin = await createGatewayPlugin({ plugin: { config: { appConfig: enabledConfig } } });
  const disabledPlugin = await createGatewayPlugin({ plugin: { config: { appConfig: disabledConfig } } });
  const transform = plugin.requestTransforms.find((item) => item.key === ccrBailianEnhancedSearchRequestTransformKey);
  const disabledTransform = disabledPlugin.requestTransforms.find((item) => item.key === ccrBailianEnhancedSearchRequestTransformKey);
  const baseInput = {
    request: { headers: {}, id: `gate-${t.name}`, method: "POST", url: "/v1/messages" },
    requestBody: anthropicWebSearchRequestBody(),
    route: { method: "POST", url: "/v1/messages" },
    targetProvider: "bailian::anthropic_messages",
    targetProviderConfig: { name: "bailian::anthropic_messages", type: "anthropic_messages" }
  };

  try {
    assert.equal(await disabledTransform.transform(baseInput), undefined);

    const openAiTarget = await transform.transform({
      ...baseInput,
      targetProvider: "bailian::openai_chat_completions",
      targetProviderConfig: { name: "bailian::openai_chat_completions", type: "openai_chat_completions" }
    });
    assert.equal(openAiTarget, undefined);

    const openAiClientPath = await transform.transform({
      ...baseInput,
      request: { headers: {}, id: `gate2-${t.name}`, method: "POST", url: "/v1/chat/completions" },
      route: { method: "POST", url: "/v1/chat/completions" }
    });
    assert.equal(openAiClientPath, undefined);

    const withoutTool = await transform.transform({
      ...baseInput,
      requestBody: { ...anthropicWebSearchRequestBody(), tools: [{ name: "bash", type: "custom" }] }
    });
    assert.equal(withoutTool, undefined);

    const otherProvider = await transform.transform({
      ...baseInput,
      targetProvider: "other-provider::anthropic_messages",
      targetProviderConfig: { name: "other-provider::anthropic_messages", type: "anthropic_messages" }
    });
    assert.equal(otherProvider, undefined);

    const stub = installMcpFetchStub([{ body: "", status: 500 }, { body: "", status: 500 }, { body: "", status: 500 }, { body: "", status: 500 }, { body: "", status: 500 }, { body: "", status: 500 }]);
    try {
      const failure = await transform.transform(baseInput);
      assert.ok(failure);
      assert.equal(failure.ok, false);
      assert.equal(failure.status, 503);
      assert.match(failure.error, /Bailian enhanced web search did not return results/);
    } finally {
      stub.restore();
    }
  } finally {
    if (previousEndpoint === undefined) {
      delete process.env[bailianEnhancedSearchEndpointEnv];
    } else {
      process.env[bailianEnhancedSearchEndpointEnv] = previousEndpoint;
    }
  }
});

test("provider enhancedSearch config parses from persisted provider payloads", () => {
  const providers = parseProvidersForTest([{
    enhancedSearch: { apiKey: "  sk-ws-key  ", enabled: true },
    models: ["qwen3.7-max"],
    name: "Bailian",
    type: "anthropic_messages"
  }]);
  assert.equal(providers?.length, 1);
  assert.deepEqual(providers[0].enhancedSearch, { apiKey: "sk-ws-key", enabled: true });

  const disabled = parseProvidersForTest([{
    enhancedSearch: { enabled: false },
    models: ["qwen3.7-max"],
    name: "Bailian",
    type: "anthropic_messages"
  }]);
  assert.equal(disabled?.[0].enhancedSearch, undefined);
});
