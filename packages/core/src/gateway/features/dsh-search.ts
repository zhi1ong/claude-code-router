import type { AppConfig, ProfileConfig } from "@ccr/core/contracts/app";
import { normalizeBailianEnhancedSearchQuery } from "@ccr/core/gateway/features/bailian-enhanced-search/mcp";
import { boundWebSearchResults, executeProviderWebSearch, providerWebSearchBackend, resolveProviderWebSearchModel,
  type ProviderWebSearchContext, type ProviderWebSearchError, type ProviderWebSearchOutcome } from "@ccr/core/gateway/features/provider-web-search";
import { parseJsonObjectSafe } from "@ccr/core/gateway/http/body";
import { stringValue } from "@ccr/core/gateway/internal/value";
import { normalizeRouteSelector } from "@ccr/core/routing/model-registry";

export type DshSearchContext = {
  count?: number;
  model?: string;
  search?: ProviderWebSearchContext;
  error?: ProviderWebSearchError;
};

/**
 * DSH's Search API (`POST {base}/search`, base `{CCR}/v1/tools`) carries no model;
 * the authenticated profile default chooses the search upstream.
 */
export function prepareDshSearchRequest(input: {
  config: AppConfig;
  profile: ProfileConfig | undefined;
  method: string;
  path: string;
  body: Buffer | undefined;
}): DshSearchContext | undefined {
  if (input.method.toUpperCase() !== "POST" || !/^\/(?:v1\/)?tools\/search\/?$/.test(input.path)) return undefined;
  const model = input.profile?.enabled ? normalizeRouteSelector(input.profile.model) : undefined;
  const body = parseJsonObjectSafe(input.body);
  const text = stringValue(body?.query)?.trim();
  if (!text) return { model, error: { statusCode: 400, message: "query is required and must be a non-empty string." } };
  const count = body?.count;
  if (count !== undefined && count !== null && !(Number.isInteger(count) && (count as number) > 0)) {
    return { model, error: { statusCode: 400, message: "count must be a positive integer." } };
  }
  const target = resolveProviderWebSearchModel(input.config, model);
  const backend = target && providerWebSearchBackend(target.provider);
  if (!model || !target || !backend) {
    return { model, error: { statusCode: 503,
      message: "Web search requires a supported default model provider in the authenticated profile." } };
  }
  const query = backend === "kimi" ? text : normalizeBailianEnhancedSearchQuery(text);
  if (!query) return { model, error: { statusCode: 400, message: "query must contain at least two characters." } };
  return { count: typeof count === "number" ? count : undefined, model,
    search: { config: input.config, provider: target.provider, backend, query } };
}

export async function executeDshSearchRequest(context: DshSearchContext, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const outcome: ProviderWebSearchOutcome = context.error ? { kind: "error", ...context.error } : (context.search
    ? await executeProviderWebSearch(context.search, signal)
    : { kind: "error", statusCode: 503, message: "Web search has no available default model provider." });
  return {
    statusCode: outcome.kind === "error" ? outcome.statusCode : 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(outcome.kind === "error" ? { error: { message: outcome.message } } : {
      results: boundWebSearchResults(outcome.results).slice(0, context.count).map((result) => ({
        url: result.url, title: result.title, snippet: result.snippet ?? "", date: null
      }))
    }),
    ...(outcome.kind === "error" ? { error: outcome.message } : {})
  };
}
