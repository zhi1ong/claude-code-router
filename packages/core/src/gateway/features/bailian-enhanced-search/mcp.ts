import { fetchWithSystemProxy } from "@ccr/core/proxy/system-proxy-fetch";
import { formatError } from "@ccr/core/gateway/http/io";
import { isRecord, stringValue } from "@ccr/core/gateway/internal/value";
import type { BrowserWebSearchProtocolResult } from "@ccr/core/gateway/internal/shared";

export const defaultBailianEnhancedSearchMcpEndpoint = "https://dashscope.aliyuncs.com/api/v1/mcps/EnhancedSearch/mcp";
export const bailianEnhancedSearchEndpointEnv = "BAILIAN_ENHANCED_SEARCH_ENDPOINT";

const bailianEnhancedSearchMcpProtocolVersion = "2024-11-05";
const bailianEnhancedSearchToolName = "search_pro";
const bailianEnhancedSearchMaxQueryLength = 500;
const bailianEnhancedSearchMinQueryLength = 2;

type BailianEnhancedSearchInput = {
  apiKey: string;
  endpoint?: string;
  query: string;
  timeoutMs: number;
};

export function normalizeBailianEnhancedSearchQuery(query: string | undefined): string | undefined {
  const trimmed = query?.trim() ?? "";
  if (trimmed.length < bailianEnhancedSearchMinQueryLength) {
    return undefined;
  }
  return trimmed.slice(0, bailianEnhancedSearchMaxQueryLength);
}

/**
 * Runs one enhanced web search through the Bailian EnhancedSearch MCP endpoint.
 * The endpoint is stateless JSON-RPC over HTTP, but it only serves tools/call
 * after a full initialize/initialized handshake, so every search performs the
 * three-request sequence. One retry covers the observed transient empty 200.
 */
export async function searchBailianEnhancedWeb(input: BailianEnhancedSearchInput): Promise<BrowserWebSearchProtocolResult[]> {
  const query = normalizeBailianEnhancedSearchQuery(input.query);
  if (!query) {
    return [];
  }
  const endpoint = input.endpoint?.trim() ||
    process.env[bailianEnhancedSearchEndpointEnv]?.trim() ||
    defaultBailianEnhancedSearchMcpEndpoint;
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new Error("Bailian enhanced search API key is not configured.");
  }

  // One shared deadline covers the handshake retries, so a hanging first
  // attempt cannot double the worst-case latency of the request path.
  const signal = AbortSignal.timeout(input.timeoutMs);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await searchBailianEnhancedWebOnce({ apiKey, endpoint, query, signal });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(formatError(lastError));
}

async function searchBailianEnhancedWebOnce(input: {
  apiKey: string;
  endpoint: string;
  query: string;
  signal: AbortSignal;
}): Promise<BrowserWebSearchProtocolResult[]> {
  const initialize = await postBailianEnhancedSearchRpc(input, {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "claude-code-router", version: "1.0.0" },
      protocolVersion: bailianEnhancedSearchMcpProtocolVersion
    }
  }, input.signal);
  if (!initialize?.result) {
    throw new Error("Bailian enhanced search handshake did not complete.");
  }
  // The server answers notifications/initialized with 202 and an empty body.
  await postBailianEnhancedSearchRpc(input, {
    jsonrpc: "2.0",
    method: "notifications/initialized"
  }, input.signal);
  const call = await postBailianEnhancedSearchRpc(input, {
    id: 2,
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      arguments: { query: input.query },
      name: bailianEnhancedSearchToolName
    }
  }, input.signal);
  return bailianEnhancedSearchResultsFromToolResult(call);
}

async function postBailianEnhancedSearchRpc(
  input: { apiKey: string; endpoint: string },
  payload: Record<string, unknown>,
  signal: AbortSignal
): Promise<Record<string, unknown> | undefined> {
  const response = await fetchWithSystemProxy(input.endpoint, {
    body: JSON.stringify(payload),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json"
    },
    method: "POST",
    signal
  });
  if (!response.ok) {
    throw new Error(`Bailian enhanced search endpoint returned HTTP ${response.status}.`);
  }
  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    return parseBailianEnhancedSearchSseMessage(text);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("Bailian enhanced search endpoint returned an unexpected payload.");
    }
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Bailian enhanced search endpoint returned an unparseable payload.");
    }
    throw error;
  }
}

function parseBailianEnhancedSearchSseMessage(text: string): Record<string, unknown> | undefined {
  let message: Record<string, unknown> | undefined;
  for (const block of text.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) {
        continue;
      }
      try {
        const parsed = JSON.parse(line.slice(5).trim()) as unknown;
        if (isRecord(parsed)) {
          message = parsed;
        }
      } catch {
        // Skip malformed SSE data lines.
      }
    }
  }
  return message;
}

function bailianEnhancedSearchResultsFromToolResult(value: Record<string, unknown> | undefined): BrowserWebSearchProtocolResult[] {
  const result = value?.result;
  if (!isRecord(result)) {
    throw new Error("Bailian enhanced search tool call returned no result.");
  }
  const text = bailianEnhancedSearchToolResultText(result);
  if (result.isError === true) {
    throw new Error(text ? `Bailian enhanced search failed: ${text}` : "Bailian enhanced search tool call failed.");
  }
  const payload = parseToolResultJson(text);
  const pages = isRecord(payload) && Array.isArray(payload.pages) ? payload.pages : [];
  return pages.map(bailianEnhancedSearchResultFromPage).filter((item): item is BrowserWebSearchProtocolResult => Boolean(item));
}

function bailianEnhancedSearchToolResultText(result: Record<string, unknown>): string | undefined {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .flatMap((part) => isRecord(part) && stringValue(part.type) === "text" && stringValue(part.text) ? [stringValue(part.text)] : [])
    .join("\n")
    .trim();
  return text || undefined;
}

function parseToolResultJson(text: string | undefined): unknown {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function bailianEnhancedSearchResultFromPage(page: unknown): BrowserWebSearchProtocolResult | undefined {
  if (!isRecord(page)) {
    return undefined;
  }
  const title = stringValue(page.title) || "";
  const url = stringValue(page.url) || "";
  if (!title && !url) {
    return undefined;
  }
  const snippet = stringValue(page.snippet);
  return {
    ...(snippet ? { snippet } : {}),
    title,
    url
  };
}
