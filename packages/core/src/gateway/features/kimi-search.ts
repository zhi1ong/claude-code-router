import type { AppConfig, GatewayProviderConfig, GatewayProviderProtocol } from "@ccr/core/contracts/app";
import { kimiIdentityHeaders } from "@ccr/core/agents/local-providers/kimi";
import { localAgentOauthProviderHooks } from "@ccr/core/gateway/core-runtime/local-agent-auth-provider-hook";
import { mergeUpstreamProviderHeaders } from "@ccr/core/gateway/core-runtime/upstream-header-sanitizer";
import type { BrowserWebSearchProtocolResult } from "@ccr/core/gateway/internal/shared";
import { isRecord, stringValue } from "@ccr/core/gateway/internal/value";
import { providerCapabilityForClientProtocol, providerCapabilityNameMatches, providerProtocolForClientProtocol } from "@ccr/core/providers/runtime-topology";
import { fetchWithSystemProxy } from "@ccr/core/proxy/system-proxy-fetch";
import { providerRuntimeId } from "@ccr/core/routing/model-registry";

class KimiSearchError extends Error {
  constructor(message: string, readonly statusCode?: number) { super(message); }
}

export function kimiSearchHttpStatus(error: unknown): number | undefined {
  return error instanceof KimiSearchError ? error.statusCode : undefined;
}

/** Kimi Code's Anthropic and Chat endpoints share the same native search API. */
export function kimiSearchTarget(provider: GatewayProviderConfig): { url: string; protocol: GatewayProviderProtocol } | undefined {
  const capability = providerCapabilityForClientProtocol(provider, "anthropic_messages");
  const protocol = capability?.type ?? providerProtocolForClientProtocol(provider, "anthropic_messages");
  const baseUrl = capability?.baseUrl || provider.baseurl || provider.baseUrl || provider.api_base_url;
  if (provider.enabled === false || !baseUrl || !protocol) return undefined;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.hostname !== "api.kimi.com" ||
      !/^\/coding(?:\/v1)?\/?$/.test(url.pathname) || url.username || url.password) return undefined;
    url.pathname = "/coding/v1/search";
    url.search = "";
    url.hash = "";
    return { url: url.toString(), protocol };
  } catch {
    return undefined;
  }
}

export async function searchKimiWeb(input: {
  config: Pick<AppConfig, "providerPlugins">;
  provider: GatewayProviderConfig;
  apiKey: string;
  credentialName?: string;
  query: string;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<BrowserWebSearchProtocolResult[]> {
  const target = kimiSearchTarget(input.provider);
  if (!target) throw new KimiSearchError("Kimi web search has no official upstream endpoint.");
  const deadline = AbortSignal.timeout(input.timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  try {
    signal.throwIfAborted();
    const plugins = (input.config.providerPlugins ?? []).filter((plugin) => {
      if (!isRecord(plugin) || plugin.enabled === false) return false;
      const name = stringValue(plugin.providerName)?.trim().toLowerCase();
      return Boolean(name && ([input.provider.name, providerRuntimeId(input.provider), input.credentialName]
        .some((value) => value?.trim().toLowerCase() === name) ||
        providerCapabilityNameMatches(input.provider, target.protocol, name)));
    });
    const upstreamHeaders: Record<string, string> = {
      ...kimiIdentityHeaders(),
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json"
    };
    for (const settings of [input.provider.extraHeaders, ...plugins.flatMap((plugin) =>
      isRecord(plugin) ? [isRecord(plugin.auth) ? plugin.auth.headers : undefined,
        isRecord(plugin.request) ? plugin.request.headers : undefined] : [])]) {
      if (!isRecord(settings)) continue;
      for (const [name, value] of Object.entries(settings)) {
        if (typeof value === "string") upstreamHeaders[name.toLowerCase()] = value;
      }
    }
    let headers = mergeUpstreamProviderHeaders(undefined, upstreamHeaders);
    for (const hook of localAgentOauthProviderHooks({ providerPlugins: plugins })) {
      for (const apply of [hook.authenticate, hook.transformRequest]) {
        if (!apply) continue;
        const result = await apply({ upstreamRequest: { url: target.url, headers } });
        if (!result.ok) throw new KimiSearchError("Kimi web search authentication failed.");
        headers = result.value.headers ?? headers;
      }
    }
    headers = mergeUpstreamProviderHeaders(undefined, headers);
    signal.throwIfAborted();
    const response = await fetchWithSystemProxy(target.url, {
      method: "POST", headers, body: JSON.stringify({ text_query: input.query }), redirect: "manual", signal
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new KimiSearchError(`Kimi web search returned HTTP ${response.status}.`, response.status);
    }
    const payload: unknown = JSON.parse(await readSearchResponse(response, signal));
    if (!isRecord(payload) || !Array.isArray(payload.search_results)) {
      throw new KimiSearchError("Kimi web search returned an invalid response.");
    }
    return payload.search_results.filter(isRecord).map((result) => ({
      title: stringValue(result.title) ?? "", url: stringValue(result.url) ?? "",
      snippet: stringValue(result.snippet)
    }));
  } catch (error) {
    input.signal?.throwIfAborted();
    if (signal.aborted) throw new DOMException("Kimi web search timed out.", "TimeoutError");
    if (error instanceof KimiSearchError) throw error;
    throw new KimiSearchError("Kimi web search failed.");
  }
}

async function readSearchResponse(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new KimiSearchError("Kimi web search returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new KimiSearchError("Kimi web search response is too large.");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
