import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { AppConfig, GatewayProviderConfig } from "@ccr/core/contracts/app";
import { isRecord, stringValue } from "@ccr/core/gateway/internal/value";
import type { BrowserWebSearchProtocolResult } from "@ccr/core/gateway/internal/shared";
import { searchBailianEnhancedWeb } from "@ccr/core/gateway/features/bailian-enhanced-search/mcp";

const bailianEnhancedSearchSideQueryTimeoutMs = 15_000;
const bailianEnhancedSearchMaxResults = 8;
const claudeCodeWebSearchQueryPrefix = /^perform\s+a\s+web\s+search\s+for\s+the\s+query:\s*/i;
const bailianEnhancedSearchTokenEstimateDivisor = 4;

type SideQueryRequest = {
  body?: unknown;
};

export type BailianEnhancedSearchSideQueryReply = {
  code(statusCode: number): { send(payload: unknown): unknown };
  hijack?(): void;
  raw?: ServerResponse;
  send(payload: unknown): unknown;
};

/**
 * Answers Claude Code WebSearch side queries for providers with the enhanced
 * search option enabled. The CLI runs its own web_search tool-use loop: when it
 * needs search results it posts a dedicated /v1/messages request that declares
 * only a web_search tool with a "Perform a web search for the query: ..." user
 * message. This handler recognizes that shape, runs the query through the
 * Bailian EnhancedSearch MCP, and replies with an Anthropic message carrying
 * server_tool_use + web_search_tool_result blocks, so the client experiences
 * the official server-side web search verbatim. Every other request — including
 * the main conversation turns — is left untouched for the gateway to handle.
 */
export async function handleBailianEnhancedSearchSideQuery(input: {
  config: AppConfig;
  request: SideQueryRequest;
  reply: BailianEnhancedSearchSideQueryReply;
}): Promise<void> {
  const body = isRecord(input.request.body) ? input.request.body : undefined;
  if (!body || !isBailianEnhancedSearchSideQueryBody(body)) {
    return;
  }
  const provider = bailianEnhancedSearchSideQueryProvider(input.config);
  if (!provider) {
    return;
  }
  const query = stripClaudeCodeWebSearchQueryPrefix(sideQueryUserText(body));
  if (!query?.trim()) {
    writeSideQueryError(input.reply, 400, "invalid_request_error", "Web search query is required.");
    return;
  }
  const apiKey = provider.enhancedSearch?.apiKey?.trim() || providerApiKey(provider);
  if (!apiKey) {
    writeSideQueryError(input.reply, 503, "api_error", "Bailian enhanced web search is enabled but no API key is configured.");
    return;
  }

  let results: BrowserWebSearchProtocolResult[];
  try {
    results = (await searchBailianEnhancedWeb({
      apiKey,
      query: query.trim(),
      timeoutMs: bailianEnhancedSearchSideQueryTimeoutMs
    })).slice(0, bailianEnhancedSearchMaxResults);
  } catch (error) {
    const message = error instanceof Error ? error.message : "search failed";
    writeSideQueryError(input.reply, 502, "api_error", `Bailian enhanced web search failed: ${message}`);
    return;
  }

  const requestedModel = stringValue(body.model) || provider.models[0] || "web_search";
  if (body.stream === true) {
    writeSideQuerySseReply(input.reply, requestedModel, query.trim(), results);
  } else {
    input.reply.code(200).send(buildSideQueryMessage(requestedModel, query.trim(), results));
  }
}

/**
 * A WebSearch side query declares exactly one web-search tool (Claude Code
 * sends {type: "web_search_20250305", name: "web_search", ...}).
 */
export function isBailianEnhancedSearchSideQueryBody(body: Record<string, unknown>): boolean {
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length !== 1) {
    return false;
  }
  return isSideQueryWebSearchTool(tools[0]);
}

function isSideQueryWebSearchTool(tool: unknown): boolean {
  if (!isRecord(tool)) {
    return false;
  }
  const type = stringValue(tool.type) ?? "";
  if (type.startsWith("web_search") || type === "google_search") {
    return true;
  }
  const name = stringValue(tool.name) ?? "";
  return name === "web_search" || name === "google_search" || name === "web_search_20250305";
}

function sideQueryUserText(body: Record<string, unknown>): string | undefined {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastMessage = messages.at(-1);
  if (!isRecord(lastMessage) || stringValue(lastMessage.role) !== "user") {
    return undefined;
  }
  const content = lastMessage.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const part of content) {
    if (isRecord(part) && stringValue(part.type) === "text") {
      const text = stringValue(part.text);
      if (text) {
        return text;
      }
    }
  }
  return undefined;
}

export function stripClaudeCodeWebSearchQueryPrefix(query: string | undefined): string | undefined {
  return query?.replace(claudeCodeWebSearchQueryPrefix, "");
}

function bailianEnhancedSearchSideQueryProvider(config: AppConfig): GatewayProviderConfig | undefined {
  return (config.Providers ?? []).find((provider) =>
    provider.enabled !== false && provider.enhancedSearch?.enabled === true
  );
}

function providerApiKey(provider: GatewayProviderConfig): string | undefined {
  return provider.apikey || provider.apiKey || provider.api_key;
}

function buildSideQueryMessage(model: string, query: string, results: BrowserWebSearchProtocolResult[]): Record<string, unknown> {
  const summary = sideQueryTextSummary(query, results);
  return {
    content: sideQueryContentBlocks(query, results),
    id: `msg_ws_${randomUUID()}`,
    model,
    role: "assistant",
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: {
      input_tokens: 0,
      output_tokens: Math.trunc(summary.length / bailianEnhancedSearchTokenEstimateDivisor)
    }
  };
}

function sideQueryContentBlocks(query: string, results: BrowserWebSearchProtocolResult[]): Record<string, unknown>[] {
  const toolUseId = `srvtoolu_ws_${randomUUID().slice(0, 16)}`;
  return [
    {
      id: toolUseId,
      input: { query },
      name: "web_search",
      type: "server_tool_use"
    },
    {
      content: results.map((result) => ({
        type: "web_search_result",
        title: result.title,
        url: result.url,
        ...(result.snippet ? { page_content: result.snippet } : {})
      })),
      tool_use_id: toolUseId,
      type: "web_search_tool_result"
    },
    {
      text: sideQueryTextSummary(query, results),
      type: "text"
    }
  ];
}

function sideQueryTextSummary(query: string, results: BrowserWebSearchProtocolResult[]): string {
  if (results.length === 0) {
    return `No search results found for: ${query}`;
  }
  const lines = [`Here are the search results for "${query}":`, ""];
  results.forEach((result, index) => {
    lines.push(`${index + 1}. **${result.title}**`);
    lines.push(`   ${result.url}`);
    if (result.snippet) {
      lines.push(`   ${result.snippet}`);
    }
    lines.push("");
  });
  return lines.join("\n");
}

function writeSideQuerySseReply(
  reply: BailianEnhancedSearchSideQueryReply,
  model: string,
  query: string,
  results: BrowserWebSearchProtocolResult[]
): void {
  if (!reply.hijack || !reply.raw) {
    writeSideQueryError(reply, 500, "api_error", "Streaming web search replies are unavailable on this gateway.");
    return;
  }
  const blocks = sideQueryContentBlocks(query, results);
  const summary = stringValue(blocks.at(-1)?.text) ?? "";
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "content-type": "text/event-stream",
    "x-accel-buffering": "no"
  });
  writeSseEvent(raw, "message_start", {
    message: {
      content: [],
      id: `msg_ws_${randomUUID()}`,
      model,
      role: "assistant",
      stop_reason: null,
      stop_sequence: null,
      type: "message",
      usage: { input_tokens: 0, output_tokens: 0 }
    },
    type: "message_start"
  });
  blocks.forEach((block, index) => {
    writeSseEvent(raw, "content_block_start", {
      content_block: block,
      index,
      type: "content_block_start"
    });
    if (block.type === "text") {
      writeSseEvent(raw, "content_block_delta", {
        delta: { text: stringValue(block.text) ?? "", type: "text_delta" },
        index,
        type: "content_block_delta"
      });
    }
    writeSseEvent(raw, "content_block_stop", {
      index,
      type: "content_block_stop"
    });
  });
  writeSseEvent(raw, "message_delta", {
    delta: { stop_reason: "end_turn", stop_sequence: null },
    type: "message_delta",
    usage: {
      output_tokens: Math.trunc(summary.length / bailianEnhancedSearchTokenEstimateDivisor)
    }
  });
  writeSseEvent(raw, "message_stop", { type: "message_stop" });
  raw.end();
}

function writeSseEvent(raw: ServerResponse, event: string, data: Record<string, unknown>): void {
  raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function writeSideQueryError(
  reply: BailianEnhancedSearchSideQueryReply,
  status: number,
  type: string,
  message: string
): void {
  reply.code(status).send({
    error: { message, type },
    type: "error"
  });
}
