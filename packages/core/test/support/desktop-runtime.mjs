import { CCR_DESKTOP_APP_ENV } from "@ccr/core/runtime/desktop-app.ts";

export function mockDesktopRuntime(context) {
  const previousApp = process.env[CCR_DESKTOP_APP_ENV];
  const previousElectron = Object.getOwnPropertyDescriptor(process.versions, "electron");
  process.env[CCR_DESKTOP_APP_ENV] = "1";
  Object.defineProperty(process.versions, "electron", { configurable: true, value: "test" });
  context.after(() => {
    if (previousApp === undefined) delete process.env[CCR_DESKTOP_APP_ENV];
    else process.env[CCR_DESKTOP_APP_ENV] = previousApp;
    if (previousElectron) Object.defineProperty(process.versions, "electron", previousElectron);
    else delete process.versions.electron;
  });
}
