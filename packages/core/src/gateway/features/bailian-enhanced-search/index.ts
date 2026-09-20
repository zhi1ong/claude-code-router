/** Public facade for the Bailian enhanced-search web_search bridge. */
export { bailianEnhancedSearchEndpointEnv, defaultBailianEnhancedSearchMcpEndpoint, normalizeBailianEnhancedSearchQuery, searchBailianEnhancedWeb } from "@ccr/core/gateway/features/bailian-enhanced-search/mcp";
export {
  applyBailianEnhancedSearchBridgeRequestTransform,
  applyBailianEnhancedSearchBridgeResponseTransform,
  applyBailianEnhancedSearchBridgeStreamTransform,
  bailianEnhancedSearchBridgeProviderForTarget,
  ccrBailianEnhancedSearchBridgeHeader,
  clearBailianEnhancedSearchBridgeContextsForTest
} from "@ccr/core/gateway/features/bailian-enhanced-search/bridge";
export type { BailianEnhancedSearchBridgeRequestInput, BailianEnhancedSearchBridgeRequestResult } from "@ccr/core/gateway/features/bailian-enhanced-search/bridge";
