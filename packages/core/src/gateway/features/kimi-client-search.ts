import type { AppConfig, ProfileConfig } from "@ccr/core/contracts/app";
import { normalizeBailianEnhancedSearchQuery } from "@ccr/core/gateway/features/bailian-enhanced-search/mcp";
import { boundWebSearchResults, executeProviderWebSearch, providerWebSearchBackend, resolveProviderWebSearchModel,
  type ProviderWebSearchContext, type ProviderWebSearchError, type ProviderWebSearchOutcome } from "@ccr/core/gateway/features/provider-web-search";
import { parseJsonObjectSafe } from "@ccr/core/gateway/http/body";
import { stringValue } from "@ccr/core/gateway/internal/value";
import { normalizeRouteSelector } from "@ccr/core/routing/model-registry";

export type KimiClientSearchContext = {
  model?: string;
  search?: ProviderWebSearchContext;
  error?: ProviderWebSearchError;
};

/** Kimi's standalone search carries no model; only the authenticated profile chooses its upstream. */
export function prepareKimiClientSearchRequest(input: {
  config: AppConfig;
  profile: ProfileConfig | undefined;
  method: string;
  path: string;
  body: Buffer | undefined;
}): KimiClientSearchContext | undefined {
  if (input.method.toUpperCase() !== "POST" || !/^\/(?:v1\/)?search\/?$/.test(input.path)) return undefined;
  const model = input.profile?.agent === "kimi" && input.profile.enabled
    ? normalizeRouteSelector(input.profile.model) : undefined;
  const text = stringValue(parseJsonObjectSafe(input.body)?.text_query)?.trim();
  if (!text) return { model, error: { statusCode: 400, message: "text_query is required and must be a non-empty string." } };
  const target = resolveProviderWebSearchModel(input.config, model);
  const backend = target && providerWebSearchBackend(target.provider);
  if (!model || !target || !backend) {
    return { model, error: { statusCode: 503,
      message: "Web search requires a supported default model provider in the authenticated Kimi profile." } };
  }
  const query = backend === "kimi" ? text : normalizeBailianEnhancedSearchQuery(text);
  if (!query) return { model, error: { statusCode: 400, message: "text_query must contain at least two characters." } };
  return { model, search: { config: input.config, provider: target.provider, backend, query } };
}

export async function executeKimiClientSearchRequest(context: KimiClientSearchContext, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const outcome: ProviderWebSearchOutcome = context.error ? { kind: "error", ...context.error } : (context.search
    ? await executeProviderWebSearch(context.search, signal)
    : { kind: "error", statusCode: 503, message: "Web search has no available default model provider." });
  return {
    statusCode: outcome.kind === "error" ? outcome.statusCode : 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(outcome.kind === "error" ? { error: { message: outcome.message } } : {
      search_results: boundWebSearchResults(outcome.results).map((result) => ({
        ...result, snippet: result.snippet ?? ""
      }))
    }),
    ...(outcome.kind === "error" ? { error: outcome.message } : {})
  };
}
