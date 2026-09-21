import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { OverviewWidgetConfig } from "@ccr/core/contracts/app.ts";
import { OverviewView } from "@ccr/ui/pages/home/components/dashboard.tsx";
import { AppI18nContext, appCopy } from "@ccr/ui/pages/home/shared/i18n.tsx";
import { installBrowserGlobals, usageRow, usageStats } from "../fixtures/index.ts";

installBrowserGlobals();

const rows = Array.from({ length: 8 }, (_, index) => {
  const client = index < 3 ? "unknown" : "Mac mini";
  const credentialId = index === 1 ? "backup" : "primary";
  const model = index < 2 ? "shared-model" : `model-${index}`;
  return usageRow(`client-${index}`, client, {
    caption: `provider / ${credentialId} / ${model}`,
    client,
    credentialId,
    model,
    provider: "provider",
    totalTokens: 8000 - index * 1000
  });
});

for (const [size, variant] of [["2:2", "table"], ["4:2", "compact"], ["3:2", "table"], ["4:2", "table"]] as const) {
  test(`client analysis distinguishes same-name groups in ${size} ${variant}`, () => {
    const widget: OverviewWidgetConfig = { enabled: true, id: "clients", size, type: "client-analysis", variant };
    const html = renderToStaticMarkup(
      <AppI18nContext.Provider value={appCopy.zh}>
        <OverviewView
          overviewWidgets={[widget]}
          providerAccounts={[]}
          setUsageRange={() => undefined}
          usageRange="30d"
          usageStats={usageStats("30d", { clientModels: rows })}
          onWidgetsChange={() => undefined}
        />
      </AppI18nContext.Provider>
    );
    const visibleText = html.replace(/<[^>]*>/g, " ");
    assert.match(visibleText, /8 组/);
    assert.match(visibleText, /未识别客户端/);
    assert.match(visibleText, /Mac mini/);
    assert.doesNotMatch(visibleText, /unknown/);
    assert.match(visibleText, /Token/);
    if (size === "4:2" && variant === "table") {
      assert.match(visibleText, /凭据/);
      assert.match(visibleText, /primary/);
      assert.match(visibleText, /backup/);
      assert.match(visibleText, /model-7/);
    } else {
      for (const row of rows) assert.ok(visibleText.includes(row.caption), row.caption);
    }
  });
}
