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
  handleBailianEnhancedSearchSideQuery,
  isBailianEnhancedSearchSideQueryBody,
  stripClaudeCodeWebSearchQueryPrefix
} from "@ccr/core/gateway/features/bailian-enhanced-search/side-query.ts";
import { ccrBailianEnhancedSearchRouteKey } from "@ccr/core/gateway/core-runtime/router-plugin-contract.ts";
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

function sideQueryRequestBody(query, options = {}) {
  return {
    max_tokens: 4096,
    messages: [{ content: `Perform a web search for the query: ${query}`, role: "user" }],
    model: "claude-sonnet-5",
    stream: options.stream ?? false,
    system: "You are an assistant for performing a web search tool use",
    thinking: { type: "disabled" },
    tool_choice: { type: "tool", name: "web_search" },
    tools: [{
      allowed_domains: options.allowedDomains,
      blocked_domains: options.blockedDomains,
      max_uses: 8,
      name: "web_search",
      type: "web_search_20250305"
    }]
  };
}

function enabledProviderConfig() {
  const config = createDefaultAppConfig();
  config.Providers = [{
    enhancedSearch: { apiKey: "sk-ws-test", enabled: true },
    id: "bailian",
    models: ["glm-5.3"],
    name: "Alibaba Bailian",
    type: "anthropic_messages"
  }];
  return config;
}

function mockReply() {
  const state = { body: undefined, code: undefined, ended: false, headers: undefined, hijacked: false, sent: false };
  const chunks = [];
  const reply = {
    code(status) {
      state.code = status;
      return { send(payload) { state.sent = true; state.body = payload; return payload; } };
    },
    hijack() {
      state.hijacked = true;
    },
    get raw() {
      return {
        writeHead(status, headers) {
          state.code = status;
          state.headers = headers;
        },
        write(chunk) {
          chunks.push(String(chunk));
        },
        end() {
          state.ended = true;
          state.sent = true;
        }
      };
    },
    send(payload) {
      state.sent = true;
      state.body = payload;
      return payload;
    }
  };
  return { chunks, reply, state };
}

function withLoopbackEndpoint(run) {
  return async () => {
    const previous = process.env[bailianEnhancedSearchEndpointEnv];
    process.env[bailianEnhancedSearchEndpointEnv] = loopbackEndpoint;
    try {
      await run();
    } finally {
      if (previous === undefined) {
        delete process.env[bailianEnhancedSearchEndpointEnv];
      } else {
        process.env[bailianEnhancedSearchEndpointEnv] = previous;
      }
    }
  };
}

test("normalizeBailianEnhancedSearchQuery trims, clamps, and rejects short queries", () => {
  assert.equal(normalizeBailianEnhancedSearchQuery("  claude code  "), "claude code");
  assert.equal(normalizeBailianEnhancedSearchQuery("a"), undefined);
  assert.equal(normalizeBailianEnhancedSearchQuery(undefined), undefined);
  assert.equal(normalizeBailianEnhancedSearchQuery("x".repeat(600)).length, 500);
});

test("side query detection matches Claude Code web search requests only", () => {
  assert.equal(isBailianEnhancedSearchSideQueryBody(sideQueryRequestBody("上海天气")), true);
  assert.equal(isBailianEnhancedSearchSideQueryBody({ ...sideQueryRequestBody("x"), tools: [{ name: "web_search", type: "web_search_20260209" }] }), true);
  assert.equal(isBailianEnhancedSearchSideQueryBody({ ...sideQueryRequestBody("x"), tools: [{ name: "google_search", type: "google_search" }] }), true);
  // A main conversation request with regular tools is not a side query.
  assert.equal(isBailianEnhancedSearchSideQueryBody({
    messages: [{ content: "hello", role: "user" }],
    tools: [
      { name: "WebSearch", description: "Search", input_schema: { type: "object" } },
      { name: "Bash", description: "Run", input_schema: { type: "object" } }
    ]
  }), false);
  assert.equal(isBailianEnhancedSearchSideQueryBody({ messages: [{ content: "hello", role: "user" }] }), false);
  assert.equal(isBailianEnhancedSearchSideQueryBody({ ...sideQueryRequestBody("x"), tools: [{ name: "web_search", type: "web_search_20250305" }, { name: "Bash" }] }), false);
});

test("Claude Code web search query prefix is stripped", () => {
  assert.equal(stripClaudeCodeWebSearchQueryPrefix("Perform a web search for the query: 上海天气"), "上海天气");
  assert.equal(stripClaudeCodeWebSearchQueryPrefix("Perform a web search for the query:   上海天气  "), "上海天气  ");
  assert.equal(stripClaudeCodeWebSearchQueryPrefix("上海天气"), "上海天气");
});

test("CCR router core plugin answers web search side queries with an Anthropic message", withLoopbackEndpoint(async () => {
  const stub = installMcpFetchStub([
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json" }, status: 200 }),
    new Response("", { status: 202 }),
    mcpSearchResponse([
      { snippet: "上海多云 24-31 度", title: "上海天气", url: "https://example.test/shanghai" },
      { snippet: "", title: "", url: "" }
    ])
  ]);
  try {
    const plugin = await createGatewayPlugin({ plugin: { config: { appConfig: enabledProviderConfig() } } });
    const route = plugin.httpRoutes.find((item) => item.key === ccrBailianEnhancedSearchRouteKey);
    assert.ok(route);
    assert.equal(route.method, "POST");
    assert.equal(route.path, "/v1/messages");
    assert.equal(route.priority, "pre");
    assert.equal(route.auth, "gateway");

    const { reply, state } = mockReply();
    await route.handler({ request: { body: sideQueryRequestBody("上海天气") }, reply });

    assert.equal(state.sent, true);
    assert.equal(state.code, 200);
    const message = state.body;
    assert.equal(message.type, "message");
    assert.equal(message.role, "assistant");
    assert.equal(message.model, "claude-sonnet-5");
    assert.equal(message.stop_reason, "end_turn");
    assert.equal(message.content.length, 3);
    assert.equal(message.content[0].type, "server_tool_use");
    assert.equal(message.content[0].name, "web_search");
    assert.equal(message.content[0].input.query, "上海天气");
    assert.equal(message.content[1].type, "web_search_tool_result");
    assert.equal(message.content[1].tool_use_id, message.content[0].id);
    assert.deepEqual(message.content[1].content, [
      { page_content: "上海多云 24-31 度", title: "上海天气", type: "web_search_result", url: "https://example.test/shanghai" }
    ]);
    assert.equal(message.content[2].type, "text");
    assert.match(message.content[2].text, /Here are the search results for "上海天气":/);
    assert.match(message.content[2].text, /https:\/\/example\.test\/shanghai/);

    // The search used the stripped query, not the prefixed message.
    assert.equal(stub.requests.at(-1).body.params.arguments.query, "上海天气");
  } finally {
    stub.restore();
  }
}));

test("side query route streams the search reply as Anthropic SSE", withLoopbackEndpoint(async () => {
  const stub = installMcpFetchStub([
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json" }, status: 200 }),
    new Response("", { status: 202 }),
    mcpSearchResponse([{ snippet: "杭州晴", title: "杭州天气", url: "https://example.test/hangzhou" }])
  ]);
  try {
    const plugin = await createGatewayPlugin({ plugin: { config: { appConfig: enabledProviderConfig() } } });
    const route = plugin.httpRoutes.find((item) => item.key === ccrBailianEnhancedSearchRouteKey);
    const { chunks, reply, state } = mockReply();
    await route.handler({ request: { body: sideQueryRequestBody("杭州天气", { stream: true }) }, reply });

    assert.equal(state.hijacked, true);
    assert.equal(state.code, 200);
    assert.equal(state.headers["content-type"], "text/event-stream");
    assert.equal(state.ended, true);
    const text = chunks.join("");
    assert.match(text, /event: message_start\ndata: \{"message":/);
    assert.match(text, /"type":"server_tool_use"/);
    assert.match(text, /"input":\{"query":"杭州天气"\}/);
    assert.match(text, /"type":"web_search_tool_result"/);
    assert.match(text, /"type":"web_search_result","title":"杭州天气","url":"https:\/\/example\.test\/hangzhou"/);
    assert.match(text, /"type":"content_block_delta"/);
    assert.match(text, /"stop_reason":"end_turn"/);
    assert.match(text, /event: message_stop/);
  } finally {
    stub.restore();
  }
}));

test("side query route passes requests through when gates do not hit", withLoopbackEndpoint(async () => {
  const plugin = await createGatewayPlugin({ plugin: { config: { appConfig: enabledProviderConfig() } } });
  const route = plugin.httpRoutes.find((item) => item.key === ccrBailianEnhancedSearchRouteKey);

  // Main conversation traffic (several tools) is untouched.
  const main = mockReply();
  await route.handler({
    request: {
      body: {
        messages: [{ content: "帮我修个 bug", role: "user" }],
        model: "claude-sonnet-5",
        stream: true,
        tools: [
          { name: "WebSearch", description: "Search the web", input_schema: { type: "object" } },
          { name: "Bash", description: "Run a command", input_schema: { type: "object" } },
          { name: "Read", description: "Read a file", input_schema: { type: "object" } }
        ]
      }
    },
    reply: main.reply
  });
  // Only one tool but it is the client-side WebSearch tool, not a server tool.
  await route.handler({
    request: { body: { ...sideQueryRequestBody("x"), tools: [{ name: "WebSearch", input_schema: { type: "object" } }] } },
    reply: main.reply
  });
  assert.equal(main.state.sent, false);

  // Feature disabled: side queries fall through untouched.
  const disabledConfig = createDefaultAppConfig();
  disabledConfig.Providers = [{
    enhancedSearch: { enabled: false },
    id: "bailian",
    models: ["glm-5.3"],
    name: "Alibaba Bailian",
    type: "anthropic_messages"
  }];
  const disabledPlugin = await createGatewayPlugin({ plugin: { config: { appConfig: disabledConfig } } });
  const disabledRoute = disabledPlugin.httpRoutes.find((item) => item.key === ccrBailianEnhancedSearchRouteKey);
  const disabled = mockReply();
  await disabledRoute.handler({ request: { body: sideQueryRequestBody("上海天气") }, reply: disabled.reply });
  assert.equal(disabled.state.sent, false);
}));

test("side query route reports search failures as Anthropic API errors", withLoopbackEndpoint(async () => {
  const stub = installMcpFetchStub([{ body: "", status: 500 }, { body: "", status: 500 }, { body: "", status: 500 }, { body: "", status: 500 }, { body: "", status: 500 }, { body: "", status: 500 }]);
  try {
    const plugin = await createGatewayPlugin({ plugin: { config: { appConfig: enabledProviderConfig() } } });
    const route = plugin.httpRoutes.find((item) => item.key === ccrBailianEnhancedSearchRouteKey);
    const { reply, state } = mockReply();
    await route.handler({ request: { body: sideQueryRequestBody("上海天气") }, reply });

    assert.equal(state.sent, true);
    assert.equal(state.code, 502);
    assert.equal(state.body.type, "error");
    assert.equal(state.body.error.type, "api_error");
    assert.match(state.body.error.message, /Bailian enhanced web search failed/);
  } finally {
    stub.restore();
  }
}));

test("searchBailianEnhancedWeb performs the MCP handshake and maps pages to results", withLoopbackEndpoint(async () => {
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
  } finally {
    stub.restore();
  }
}));

test("searchBailianEnhancedWeb retries once after an empty response", withLoopbackEndpoint(async () => {
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
  }
}));

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
