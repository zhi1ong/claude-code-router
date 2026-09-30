import type { AppConfig, GatewayProviderConfig } from "@ccr/core/contracts/app";
import { isRecord, stringValue } from "@ccr/core/gateway/internal/value";
import type { BrowserWebSearchProtocolResult } from "@ccr/core/gateway/internal/shared";
import { normalizeBailianEnhancedSearchQuery } from "@ccr/core/gateway/features/bailian-enhanced-search/mcp";
import { executeBailianEnhancedSearchResults } from "@ccr/core/gateway/features/bailian-enhanced-search/side-query";

const moonshotSearchMaxResults = 8;
const moonshotSearchTitleMaxLength = 500;
const moonshotSearchUrlMaxLength = 2_000;
const moonshotSearchSnippetMaxLength = 4_000;

export const moonshotSearchPaths = ["/v1/search", "/search"] as const;

export type MoonshotSearchContext = {
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
 * body {"text_query": "..."}). The request carries no model, so the provider is
 * the first enabled one with enhancedSearch on.
 */
export function prepareMoonshotSearchRequest(input: {
  config: AppConfig;
  method: string;
  path: string;
  body: Buffer | undefined;
}): MoonshotSearchContext | undefined {
  if (input.method.toUpperCase() !== "POST" || !moonshotSearchPaths.includes(input.path as (typeof moonshotSearchPaths)[number]) || !input.body) {
    return undefined;
  }
  if (!input.config.Providers.some((provider) => provider.enabled !== false && provider.enhancedSearch?.enabled === true)) {
    return undefined;
  }
  let body: unknown;
  try {
    body = JSON.parse(input.body.toString("utf8"));
  } catch {
    return { query: "", validationError: "text_query is required and the body must be valid JSON." };
  }
  if (!isRecord(body)) {
    return { query: "", validationError: "text_query is required and the body must be valid JSON." };
  }
  const query = normalizeBailianEnhancedSearchQuery(stringValue(body.text_query));
  if (!query) {
    return { query: "", validationError: "text_query is required and must contain at least two characters." };
  }
  return {
    provider: firstEnhancedSearchProvider(input.config),
    query
  };
}

/**
 * Execute the search and return the moonshot_search wire response:
 * always HTTP 200 with {"search_results":[...]} on success; client-facing
 * errors reuse the Kimi CLI's plain {"error": {...}} shape.
 */
export async function executeMoonshotSearchRequest(
  context: MoonshotSearchContext,
  signal?: AbortSignal
): Promise<MoonshotSearchResponse> {
  if (context.validationError) {
    return moonshotError(400, context.validationError);
  }
  if (!context.provider) {
    return moonshotError(503, "Bailian enhanced web search has no available API key.");
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

function firstEnhancedSearchProvider(config: AppConfig): GatewayProviderConfig | undefined {
  // Routing has no model to key on, so searches run on the first enabled
  // provider with enhancedSearch enabled.
  return config.Providers.find((provider) => provider.enabled !== false && provider.enhancedSearch?.enabled === true);
}

function moonshotError(statusCode: number, message: string): MoonshotSearchResponse {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ error: { message } }),
    error: message
  };
}
