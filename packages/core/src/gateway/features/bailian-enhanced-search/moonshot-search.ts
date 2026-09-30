import type { IncomingHttpHeaders } from "node:http";
import { availableGatewayModelIds, type AppConfig, type GatewayProviderConfig, type ProfileConfig } from "@ccr/core/contracts/app";
import { localAgentOauthProviderHooks } from "@ccr/core/gateway/core-runtime/local-agent-auth-provider-hook";
import { mergeUpstreamProviderHeaders } from "@ccr/core/gateway/core-runtime/upstream-header-sanitizer";
import { filteredResponseHeaders } from "@ccr/core/gateway/http/io";
import { isRecord, stringValue } from "@ccr/core/gateway/internal/value";
import type { BrowserWebSearchProtocolResult } from "@ccr/core/gateway/internal/shared";
import { selectProviderCredentials } from "@ccr/core/gateway/upstream/executor";
import { normalizeBailianEnhancedSearchQuery } from "@ccr/core/gateway/features/bailian-enhanced-search/mcp";
import { executeBailianEnhancedSearchResults } from "@ccr/core/gateway/features/bailian-enhanced-search/side-query";
import { activeProviderCredentials, providerCapabilityNameMatches, toCoreGatewayProviders } from "@ccr/core/providers/runtime-topology";
import { fetchWithSystemProxy } from "@ccr/core/proxy/system-proxy-fetch";
import { modelRegistryForConfig, providerRuntimeId } from "@ccr/core/routing/model-registry";
import { resolveUsageModelAttribution } from "@ccr/core/usage/model-attribution";

const moonshotSearchMaxResults = 8;
const moonshotSearchTitleMaxLength = 500;
const moonshotSearchUrlMaxLength = 2_000;
const moonshotSearchSnippetMaxLength = 4_000;

export const moonshotSearchPaths = ["/v1/search", "/search"] as const;

export type MoonshotSearchContext = {
  config: AppConfig;
  body: Buffer;
  headers?: IncomingHttpHeaders;
  provider?: GatewayProviderConfig;
  query: string;
  validationError?: string;
};

export type MoonshotSearchResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  error?: string;
};

/**
 * Prepare a Kimi Code CLI moonshot_search service request (POST /v1/search,
 * body {"text_query": "..."}). Search follows the authenticated profile's
 * main model provider because this protocol carries no model of its own.
 */
export function prepareMoonshotSearchRequest(input: {
  config: AppConfig;
  method: string;
  path: string;
  body: Buffer | undefined;
  headers?: IncomingHttpHeaders;
  profile?: ProfileConfig;
}): MoonshotSearchContext | undefined {
  if (input.method.toUpperCase() !== "POST" || !moonshotSearchPaths.includes(input.path as (typeof moonshotSearchPaths)[number]) || !input.body) {
    return undefined;
  }
  const mainModel = input.profile && (input.profile.model?.trim() ||
    input.profile.availableModels?.find((model) => model.trim())?.trim() || availableGatewayModelIds(input.config)[0]);
  const attribution = resolveUsageModelAttribution(input.config, mainModel);
  const context: MoonshotSearchContext = {
    config: input.config, body: input.body, headers: input.headers,
    provider: modelRegistryForConfig(input.config).findProvider(attribution.provider), query: ""
  };
  if (context.provider && context.provider.enhancedSearch?.enabled !== true) return context;
  let body: unknown;
  try {
    body = JSON.parse(input.body.toString("utf8"));
  } catch {
    return { ...context, validationError: "text_query is required and the body must be valid JSON." };
  }
  if (!isRecord(body)) {
    return { ...context, validationError: "text_query is required and the body must be valid JSON." };
  }
  const query = normalizeBailianEnhancedSearchQuery(stringValue(body.text_query));
  if (!query) {
    return { ...context, validationError: "text_query is required and must contain at least two characters." };
  }
  return {
    ...context,
    query
  };
}

/**
 * Forward native search unchanged, or adapt Bailian results to moonshot_search.
 * Bridge errors reuse the Kimi CLI's plain {"error": {...}} shape.
 */
export async function executeMoonshotSearchRequest(
  context: MoonshotSearchContext,
  signal?: AbortSignal
): Promise<MoonshotSearchResponse> {
  if (context.validationError) {
    return moonshotError(400, context.validationError);
  }
  if (!context.provider) {
    return moonshotError(503, "Web search requires an available main model provider in the authenticated agent profile.");
  }
  if (context.provider.enhancedSearch?.enabled !== true) {
    return forwardMoonshotSearchRequest(context, signal);
  }
  const outcome = await executeBailianEnhancedSearchResults(context.provider, context.query, { signal });
  if (outcome.kind === "error") {
    return moonshotError(outcome.statusCode, outcome.message);
  }
  const searchResults = outcome.results.slice(0, moonshotSearchMaxResults).map(moonshotSearchResult);
  return {
    statusCode: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ search_results: searchResults })
  };
}

function moonshotSearchResult(result: BrowserWebSearchProtocolResult): Record<string, string> {
  // The Kimi CLI tolerates missing fields (falls back to empty strings), but
  // keep every field it reads so snippets survive: it renders the snippet in
  // search result citations.
  return {
    title: result.title.slice(0, moonshotSearchTitleMaxLength),
    url: result.url.slice(0, moonshotSearchUrlMaxLength),
    snippet: result.snippet?.slice(0, moonshotSearchSnippetMaxLength) ?? ""
  };
}

async function forwardMoonshotSearchRequest(context: MoonshotSearchContext, signal?: AbortSignal): Promise<MoonshotSearchResponse> {
  const provider = context.provider!;
  const runtimes = toCoreGatewayProviders(provider);
  const first = runtimes.find((item) => item.type === "openai_chat_completions") ??
    runtimes.find((item) => item.type === "anthropic_messages");
  if (!first?.baseurl) return moonshotError(503, "Web search has no upstream endpoint.");
  const credentials = activeProviderCredentials(provider);
  const protocol = first.type === "anthropic_messages" ? "anthropic_messages" : "openai_chat_completions";
  const selected = credentials.length
    ? selectProviderCredentials(provider, protocol, credentials, { imageCount: 0, totalTokens: 0 }).credentials[0]
    : undefined;
  const runtime = selected ? runtimes.find((item) => item.name === selected.internalName) : first;
  if (!runtime?.baseurl || (provider.credentials?.length && !selected)) {
    return moonshotError(503, "Web search has no available upstream credential.");
  }
  const baseUrl = runtime.baseurl.replace(/\/+$/, "");
  const url = `${baseUrl}${runtime.type === "anthropic_messages" ? "/v1" : ""}/search`;
  const upstreamHeaders: Record<string, string> = {
    "content-type": "application/json",
    ...(runtime.apikey ? { authorization: `Bearer ${runtime.apikey}` } : {})
  };
  if (isRecord(runtime.extraHeaders)) {
    for (const [name, value] of Object.entries(runtime.extraHeaders)) {
      if (typeof value === "string") upstreamHeaders[name.toLowerCase()] = value;
    }
  }
  const plugins = (context.config.providerPlugins ?? []).filter((plugin) => {
    if (!isRecord(plugin) || plugin.enabled === false) return false;
    const name = stringValue(plugin.providerName)?.trim().toLowerCase();
    return [provider.name, providerRuntimeId(provider), runtime.name].some((target) => target.trim().toLowerCase() === name) ||
      Boolean(name && providerCapabilityNameMatches(provider, runtime.type, name));
  });
  for (const plugin of plugins) {
    if (!isRecord(plugin)) continue;
    for (const settings of [plugin.auth, plugin.request]) {
      if (!isRecord(settings) || !isRecord(settings.headers)) continue;
      for (const [name, value] of Object.entries(settings.headers)) {
        if (typeof value === "string") upstreamHeaders[name.toLowerCase()] = value;
      }
    }
  }
  let headers = mergeUpstreamProviderHeaders({ ...context.headers, cookie: undefined }, upstreamHeaders);
  for (const hook of localAgentOauthProviderHooks({ providerPlugins: plugins })) {
    if (hook.authenticate) {
      const result = await hook.authenticate({ upstreamRequest: { url, headers } });
      if (!result.ok) return moonshotError(503, result.error);
      headers = result.value.headers ?? headers;
    }
    if (hook.transformRequest) {
      const result = await hook.transformRequest({ upstreamRequest: { url, headers } });
      if (!result.ok) return moonshotError(503, result.error);
      headers = result.value.headers ?? headers;
    }
  }
  const upstreamSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]);
  try {
    const response = await fetchWithSystemProxy(url, {
      body: context.body.toString("utf8"), headers, method: "POST", redirect: "manual", signal: upstreamSignal
    });
    const body = await response.text();
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-length");
    return { statusCode: response.status, headers: Object.fromEntries(filteredResponseHeaders(responseHeaders)), body,
      ...(!response.ok ? { error: `Web search upstream returned HTTP ${response.status}.` } : {}) };
  } catch {
    signal?.throwIfAborted();
    return upstreamSignal.aborted ? moonshotError(504, "Web search timed out.") : moonshotError(502, "Web search failed.");
  }
}

function moonshotError(statusCode: number, message: string): MoonshotSearchResponse {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ error: { message } }),
    error: message
  };
}
