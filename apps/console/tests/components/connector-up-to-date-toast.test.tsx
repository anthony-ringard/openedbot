import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Toaster, toast } from "@openedbot/browser-ui-kit";
import type { RuntimePublicDto } from "@openedbot/contracts-api";
import { useUpToDateToast } from "../../src/components/connector-update-dialog";
import type { ConnectorUpgradeLevel } from "../../src/lib/runtime/connector-upgrade";
import { I18nProvider } from "../../src/lib/i18n";

/**
 * The « runtime up to date » confirmation goes through the shared toaster
 * (no more ad hoc banner), once, and only when a connector that was behind
 * announces a newer version.
 */

function runtimeAt(version: string): RuntimePublicDto {
  return { id: "rt-1", name: "vps prod pve 241", link: { connector: { version } } } as unknown as RuntimePublicDto;
}

function Probe({ runtime, level }: { runtime: RuntimePublicDto; level: ConnectorUpgradeLevel | null }) {
  useUpToDateToast(runtime, level);
  return null;
}

function mount(runtime: RuntimePublicDto, level: ConnectorUpgradeLevel | null) {
  const view = render(<I18nProvider><Probe runtime={runtime} level={level} /><Toaster /></I18nProvider>);
  return (next: RuntimePublicDto, nextLevel: ConnectorUpgradeLevel | null) =>
    act(() => view.rerender(<I18nProvider><Probe runtime={next} level={nextLevel} /><Toaster /></I18nProvider>));
}

afterEach(() => {
  act(() => toast.dismiss());
  cleanup();
});

describe("useUpToDateToast", () => {
  test("a connector that was behind and now is current raises one success toast", async () => {
    const update = mount(runtimeAt("v1.5.0"), "available");
    update(runtimeAt("v1.5.1"), null);
    const [description] = await screen.findAllByText(/v1\.5\.1/, { selector: ".ui-tsc__desc" });
    expect(description?.textContent).toContain("vps prod pve 241");
    expect(document.querySelectorAll('.ui-tsc__toast[data-type="success"]:not([data-removing])').length).toBe(1);
    expect(document.querySelector('[data-slot="connector-up-to-date"]')).toBeNull();
  });

  test("no toast when the connector was never behind", () => {
    const update = mount(runtimeAt("v1.5.0"), null);
    update(runtimeAt("v1.5.1"), null);
    expect(document.querySelectorAll(".ui-tsc__toast:not([data-removing])").length).toBe(0);
  });
});
