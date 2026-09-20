import { Readable } from "node:stream";
import type { AppConfig, GatewayProviderConfig } from "@ccr/core/contracts/app";
import { isRecord, stringValue } from "@ccr/core/gateway/internal/value";
import type { BrowserWebSearchProtocolRecord, HostedWebSearchProtocolContext } from "@ccr/core/gateway/internal/shared";
import { appendAnthropicSystemText, hostedWebSearchEvidenceText, stripAnthropicHostedWebSearchTools } from "@ccr/core/gateway/features/hosted-web-search/request-transform";
import { extractAnthropicWebSearchQueryHint, hasHostedWebSearchDeclaration } from "@ccr/core/gateway/features/hosted-web-search/discovery";
import { hostedWebSearchProtocolResponseStream, transformAnthropicWebSearchProtocolResponseValue } from "@ccr/core/gateway/features/hosted-web-search/response-transform";
import { requestProtocolForPath } from "@ccr/core/routing/protocol-endpoints";
import { providerRuntimeId } from "@ccr/core/routing/model-registry";
import { normalizeProviderProtocol } from "@ccr/core/providers/runtime-topology";
import { searchBailianEnhancedWeb } from "@ccr/core/gateway/features/bailian-enhanced-search/mcp";

export const ccrBailianEnhancedSearchBridgeHeader = "x-ccr-bailian-enhanced-search-bridge";

const bailianEnhancedSearchTimeoutMs = 15_000;
const bailianEnhancedSearchBridgeContextTtlMs = 10 * 60_000;
const bailianEnhancedSearchBridgeContextMaxEntries = 128;

type BailianEnhancedSearchRequestLike = {
  request?: {
    headers?: Record<string, string | string[] | undefined>;
    id?: string;
    method?: string;
    url?: string;
  };
  route?: {
    method?: string;
    url?: string;
  };
};

export type BailianEnhancedSearchBridgeRequestInput = BailianEnhancedSearchRequestLike & {
  requestBody?: unknown;
  targetProvider?: string;
  targetProviderConfig?: {
    name?: string;
    provider?: string;
    type?: string;
  };
};

type BailianEnhancedSearchBridgeContext = {
  createdAtMs: number;
  queryHint: string;
  records: BrowserWebSearchProtocolRecord[];
  requestId: string;
};

export type BailianEnhancedSearchBridgeRequestResult =
  | {
      headers: Record<string, string | null>;
      requestBody: Record<string, unknown>;
    }
  | {
      error: string;
      ok: false;
      status: number;
    };

const bailianEnhancedSearchBridgeContexts = new Map<string, BailianEnhancedSearchBridgeContext>();

/**
 * Bridges Anthropic web_search server tool declarations on requests routed to
 * a provider with the enhanced search option enabled. The search runs before
 * the request reaches the upstream, the tool declaration is replaced by
 * prefetched evidence in the system prompt, and the response gains synthetic
 * server_tool_use/web_search_tool_result blocks so clients render the search.
 */
export async function applyBailianEnhancedSearchBridgeRequestTransform(
  config: AppConfig,
  requestInput: BailianEnhancedSearchBridgeRequestInput
): Promise<BailianEnhancedSearchBridgeRequestResult | undefined> {
  const method = requestInput.route?.method ?? requestInput.request?.method ?? "GET";
  const url = requestInput.route?.url ?? requestInput.request?.url ?? "/";
  const path = requestPath(url);
  if (method !== "POST" || requestProtocolForPath(path) !== "anthropic_messages") {
    return undefined;
  }
  const body = isRecord(requestInput.requestBody) ? requestInput.requestBody : undefined;
  if (!body || !hasHostedWebSearchDeclaration(body, "anthropic_messages")) {
    return undefined;
  }
  // Only the Anthropic protocol target keeps the response in Anthropic shape,
  // which is the only response form this bridge rewrites.
  if (normalizeProviderProtocol(requestInput.targetProviderConfig?.type) !== "anthropic_messages") {
    return undefined;
  }
  const provider = bailianEnhancedSearchBridgeProviderForTarget(
    config,
    requestInput.targetProvider ?? requestInput.targetProviderConfig?.name
  );
  if (!provider) {
    return undefined;
  }
  const requestId = bailianEnhancedSearchRequestId(requestInput);
  if (!requestId) {
    return undefined;
  }
  const queryHint = extractAnthropicWebSearchQueryHint(body);
  if (!queryHint) {
    return { error: bailianEnhancedSearchUnavailableMessage("no searchable query in the request"), ok: false, status: 503 };
  }
  const apiKey = provider.enhancedSearch?.apiKey?.trim() || providerApiKey(provider);
  if (!apiKey) {
    return { error: bailianEnhancedSearchUnavailableMessage("no API key configured"), ok: false, status: 503 };
  }

  let record: BrowserWebSearchProtocolRecord;
  try {
    const results = await searchBailianEnhancedWeb({
      apiKey,
      query: queryHint,
      timeoutMs: bailianEnhancedSearchTimeoutMs
    });
    if (results.length === 0) {
      return { error: bailianEnhancedSearchUnavailableMessage("empty search results"), ok: false, status: 503 };
    }
    record = {
      completedAtMs: Date.now(),
      engine: "bailian_enhanced_search",
      query: queryHint,
      results,
      searchUrl: defaultSearchUrl(),
      toolName: "web_search"
    };
  } catch (error) {
    return { error: bailianEnhancedSearchUnavailableMessage(error instanceof Error ? error.message : "search failed"), ok: false, status: 503 };
  }

  registerBailianEnhancedSearchBridgeContext(requestId, {
    queryHint,
    records: [record],
    requestId
  });
  const evidence = hostedWebSearchEvidenceText([record], queryHint);
  const next = stripAnthropicHostedWebSearchTools({
    ...body,
    system: appendAnthropicSystemText(body.system, evidence)
  });
  return {
    headers: {
      "content-length": null,
      "content-type": "application/json",
      [ccrBailianEnhancedSearchBridgeHeader]: "1"
    },
    requestBody: next
  };
}

export function applyBailianEnhancedSearchBridgeResponseTransform(input: {
  request?: BailianEnhancedSearchRequestLike["request"];
  responsePayload?: unknown;
  upstreamRequest?: { headers?: Record<string, string> };
}): { responsePayload: unknown } | undefined {
  const context = bailianEnhancedSearchBridgeContextForRequest(input);
  if (!context) {
    return undefined;
  }
  const transformed = transformAnthropicWebSearchProtocolResponseValue(
    input.responsePayload,
    context.records,
    context.requestId,
    context.queryHint
  );
  return transformed.changed ? { responsePayload: transformed.value } : undefined;
}

export function applyBailianEnhancedSearchBridgeStreamTransform(input: {
  request?: BailianEnhancedSearchRequestLike["request"];
  upstreamRequest?: { headers?: Record<string, string> };
  upstreamResponse: Response;
}): Response | undefined {
  const context = bailianEnhancedSearchBridgeContextForRequest(input);
  if (!context || !input.upstreamResponse.body) {
    return undefined;
  }
  const headers = new Headers(input.upstreamResponse.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  const protocolContext: HostedWebSearchProtocolContext = {
    protocol: "anthropic_messages",
    queryHint: context.queryHint,
    records: context.records,
    requestId: context.requestId,
    sinceMs: 0,
    toolName: "web_search"
  };
  const source = Readable.fromWeb(input.upstreamResponse.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
  const bridged = hostedWebSearchProtocolResponseStream(source, headers, protocolContext, undefined);
  return new Response(Readable.toWeb(bridged) as ReadableStream<Uint8Array>, {
    headers,
    status: input.upstreamResponse.status,
    statusText: input.upstreamResponse.statusText
  });
}

export function bailianEnhancedSearchBridgeProviderForTarget(
  config: AppConfig,
  targetProvider: string | undefined
): GatewayProviderConfig | undefined {
  if (!targetProvider) {
    return undefined;
  }
  for (const provider of config.Providers ?? []) {
    if (provider.enabled === false || provider.enhancedSearch?.enabled !== true) {
      continue;
    }
    const runtimeId = providerRuntimeId(provider);
    if (targetProvider === runtimeId || targetProvider.startsWith(`${runtimeId}::`)) {
      return provider;
    }
  }
  return undefined;
}

function registerBailianEnhancedSearchBridgeContext(
  requestId: string,
  context: Omit<BailianEnhancedSearchBridgeContext, "createdAtMs">
): void {
  const now = Date.now();
  for (const [key, value] of bailianEnhancedSearchBridgeContexts) {
    if (now - value.createdAtMs > bailianEnhancedSearchBridgeContextTtlMs) {
      bailianEnhancedSearchBridgeContexts.delete(key);
    }
  }
  while (bailianEnhancedSearchBridgeContexts.size >= bailianEnhancedSearchBridgeContextMaxEntries) {
    const oldest = bailianEnhancedSearchBridgeContexts.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    bailianEnhancedSearchBridgeContexts.delete(oldest);
  }
  bailianEnhancedSearchBridgeContexts.set(requestId, { ...context, createdAtMs: now });
}

function bailianEnhancedSearchBridgeContextForRequest(input: {
  request?: BailianEnhancedSearchRequestLike["request"];
  upstreamRequest?: { headers?: Record<string, string> };
}): BailianEnhancedSearchBridgeContext | undefined {
  const requestId = bailianEnhancedSearchRequestId(input);
  if (!requestId) {
    return undefined;
  }
  const context = bailianEnhancedSearchBridgeContexts.get(requestId);
  if (!context || Date.now() - context.createdAtMs > bailianEnhancedSearchBridgeContextTtlMs) {
    return undefined;
  }
  return context;
}

function bailianEnhancedSearchRequestId(input: {
  request?: BailianEnhancedSearchRequestLike["request"];
  upstreamRequest?: { headers?: Record<string, string> };
}): string | undefined {
  return stringValue(input.request?.id) ||
    headerStringValue(input.request?.headers, "x-request-id") ||
    headerStringValue(input.request?.headers, "x-client-request-id") ||
    headerStringValue(input.upstreamRequest?.headers, "x-request-id") ||
    headerStringValue(input.upstreamRequest?.headers, "x-client-request-id");
}

function headerStringValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const value = headers[name];
  if (Array.isArray(value)) {
    const first = value.find((item) => item?.trim());
    return first?.trim() || undefined;
  }
  return value?.trim() || undefined;
}

function providerApiKey(provider: GatewayProviderConfig): string | undefined {
  return provider.apikey || provider.apiKey || provider.api_key;
}

function defaultSearchUrl(): string {
  return "https://dashscope.aliyuncs.com/api/v1/mcps/EnhancedSearch/mcp";
}

function bailianEnhancedSearchUnavailableMessage(reason: string): string {
  return `Bailian enhanced web search did not return results (${reason}). Check the enhanced search API key, endpoint, and network/proxy settings, or turn off the provider's enhanced web search option.`;
}

function requestPath(url: string): string {
  try {
    return new URL(url, "http://ccr.local").pathname;
  } catch {
    return url.split("?")[0] || "/";
  }
}

export function clearBailianEnhancedSearchBridgeContextsForTest(): void {
  bailianEnhancedSearchBridgeContexts.clear();
}
