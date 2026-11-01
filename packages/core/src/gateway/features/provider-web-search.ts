import { createHash } from "node:crypto";
import type { AppConfig, GatewayProviderConfig, ProviderCredentialConfig } from "@ccr/core/contracts/app";
import type { BrowserWebSearchProtocolResult } from "@ccr/core/gateway/internal/shared";
import { bailianEnhancedSearchHttpStatus, searchBailianEnhancedWeb } from "@ccr/core/gateway/features/bailian-enhanced-search/mcp";
import { kimiSearchHttpStatus, kimiSearchTarget, searchKimiWeb } from "@ccr/core/gateway/features/kimi-search";
import { selectProviderCredentials } from "@ccr/core/gateway/upstream/executor";
import { reserveProviderCredentialUsage } from "@ccr/core/providers/credential-pool";
import { activeProviderCredentials, providerCredentialApiKey, providerCredentialRuntimeId } from "@ccr/core/providers/runtime-topology";
import { modelRegistryForConfig, providerRuntimeId } from "@ccr/core/routing/model-registry";
import { resolveUsageModelAttribution } from "@ccr/core/usage/model-attribution";

const searchTimeoutMs = 15_000;
const searchCredentialCooldownMs = 60_000;
const maxSearchCredentialCooldowns = 1_024;
const searchCredentialCooldowns = new Map<string, number>();

export type ProviderWebSearchContext = {
  backend: "bailian" | "kimi";
  config: Pick<AppConfig, "providerPlugins">;
  provider: GatewayProviderConfig;
  query: string;
};
export type ProviderWebSearchError = { statusCode: number; message: string };
export type ProviderWebSearchOutcome =
  | { kind: "results"; results: BrowserWebSearchProtocolResult[] }
  | ({ kind: "error" } & ProviderWebSearchError);

export function providerWebSearchBackend(provider: GatewayProviderConfig): ProviderWebSearchContext["backend"] | undefined {
  if (provider.enabled === false) return undefined;
  if (kimiSearchTarget(provider)) return "kimi";
  return provider.enhancedSearch?.enabled === true ? "bailian" : undefined;
}

/** Resolve the configured default, including materialized virtual model aliases. */
export function resolveProviderWebSearchModel(config: AppConfig, model: string | undefined) {
  const registry = modelRegistryForConfig(config);
  const direct = registry.resolve(model);
  if (direct?.kind === "provider") return direct;
  const target = resolveUsageModelAttribution(config, model);
  const resolved = registry.resolve(
    target.provider && target.model ? `${target.provider}/${target.model}` : model
  );
  return resolved?.kind === "provider" ? resolved : undefined;
}

/** Both client protocols share upstream authentication, limits and search-only cooldowns. */
export async function executeProviderWebSearch(
  context: ProviderWebSearchContext,
  signal?: AbortSignal
): Promise<ProviderWebSearchOutcome> {
  signal?.throwIfAborted();
  const label = context.backend === "kimi" ? "Kimi web search" : "Bailian enhanced web search";
  const credential = searchCredential(context.provider, context.backend);
  if (!credential) {
    return { kind: "error", statusCode: 503, message: `${label} has no available API key.` };
  }
  try {
    const results = context.backend === "kimi"
      ? await searchKimiWeb({ config: context.config, provider: context.provider, apiKey: credential.apiKey,
        credentialName: credential.internalName, query: context.query, signal, timeoutMs: searchTimeoutMs })
      : await searchBailianEnhancedWeb({ apiKey: credential.apiKey, query: context.query, signal, timeoutMs: searchTimeoutMs });
    return { kind: "results", results };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && error.name === "AbortError") throw error;
    const status = context.backend === "kimi" ? kimiSearchHttpStatus(error) : bailianEnhancedSearchHttpStatus(error);
    if (credential.cooldownKey && (status === 401 || status === 403 || status === 429)) {
      // A search refusal must not cool down this credential for model inference.
      if (searchCredentialCooldowns.size >= maxSearchCredentialCooldowns) {
        const oldest = searchCredentialCooldowns.keys().next().value;
        if (oldest) searchCredentialCooldowns.delete(oldest);
      }
      searchCredentialCooldowns.set(credential.cooldownKey, Date.now() + searchCredentialCooldownMs);
    }
    return error instanceof Error && error.name === "TimeoutError"
      ? { kind: "error", statusCode: 504, message: `${label} timed out.` }
      : { kind: "error", statusCode: 502, message: `${label} failed.` };
  }
}

export function boundWebSearchResults(results: BrowserWebSearchProtocolResult[]): BrowserWebSearchProtocolResult[] {
  return results.filter((result) => {
    try { return ["https:", "http:"].includes(new URL(result.url).protocol); }
    catch { return false; }
  }).slice(0, 8).map((result) => ({
    title: result.title.slice(0, 500),
    url: result.url.slice(0, 2_000),
    ...(result.snippet ? { snippet: result.snippet.slice(0, 4_000) } : {})
  }));
}

function searchCredential(provider: GatewayProviderConfig, backend: ProviderWebSearchContext["backend"]): {
  apiKey: string; cooldownKey?: string; internalName?: string;
} | undefined {
  const dedicated = backend === "bailian" ? provider.enhancedSearch?.apiKey?.trim() : undefined;
  if (dedicated) return { apiKey: dedicated };
  if (provider.credentials?.length) {
    for (const [key, until] of searchCredentialCooldowns) {
      if (until <= Date.now()) searchCredentialCooldowns.delete(key);
    }
    const credentials = activeProviderCredentials(provider).filter((credential) =>
      !searchCredentialCooldowns.has(searchCredentialCooldownKey(provider, credential))
    );
    const usage = { totalTokens: 0, imageCount: 0 };
    const protocol = backend === "kimi" ? kimiSearchTarget(provider)?.protocol : "anthropic_messages";
    if (!protocol) return undefined;
    const selected = selectProviderCredentials(provider, protocol, credentials, usage);
    const credential = selected.credentials[0]?.credential;
    return !selected.saturated && credential && reserveProviderCredentialUsage(provider, credential, usage)
      ? { apiKey: providerCredentialApiKey(credential), cooldownKey: searchCredentialCooldownKey(provider, credential),
        internalName: selected.credentials[0].internalName }
      : undefined;
  }
  const apiKey = provider.apikey?.trim() || provider.apiKey?.trim() || provider.api_key?.trim();
  return apiKey ? { apiKey } : undefined;
}

function searchCredentialCooldownKey(provider: GatewayProviderConfig, credential: ProviderCredentialConfig): string {
  return createHash("sha256")
    .update(JSON.stringify([providerRuntimeId(provider), providerCredentialRuntimeId(provider, credential), providerCredentialApiKey(credential)]))
    .digest("hex");
}
