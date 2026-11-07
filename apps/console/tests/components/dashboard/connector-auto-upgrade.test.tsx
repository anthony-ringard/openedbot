import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { RuntimeConnectorDto } from "@openedbot/contracts-api";
import { RELAY_FEATURE_AUTO_UPGRADE } from "@openedbot/contracts-connector/features";
import { I18nProvider } from "../../../src/lib/i18n";
import { AUTO_UPGRADE_COMMAND, hasAutoUpgrade } from "../../../src/lib/runtime/auto-upgrade";
import { ConnectorUpgradeNotice } from "../../../src/screens/settings/installation/cloud/cloud-link-check";

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const available: RuntimeConnectorDto = {
  agent: "edge-setup/v1.5.1", version: "v1.5.1", latestVersion: "v1.5.2", minimumVersion: null,
  outdated: false, updateAvailable: true, seenAt: null, upgradeCommand: "sudo edge-setup upgrade --yes",
};

test("hasAutoUpgrade reads the host feature only", () => {
  expect(hasAutoUpgrade([RELAY_FEATURE_AUTO_UPGRADE, "provider_management"])).toBe(true);
  expect(hasAutoUpgrade(["provider_management"])).toBe(false);
  expect(hasAutoUpgrade([])).toBe(false);
  expect(hasAutoUpgrade(null)).toBe(false);
  expect(hasAutoUpgrade(undefined)).toBe(false);
});

test("auto-upgrade off: the card offers the enable command next to upgrade", () => {
  const { container } = render(<I18nProvider><ConnectorUpgradeNotice connector={available} connected autoUpgrade={false} /></I18nProvider>);
  expect(screen.getByText("sudo edge-setup upgrade --yes")).toBeTruthy();
  expect(screen.getByText("Mise à jour automatique désactivée")).toBeTruthy();
  expect(screen.getByText(AUTO_UPGRADE_COMMAND)).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Copier la commande" })).toHaveLength(2);
  expect(container.querySelector('[data-auto-upgrade="on"]')).toBeNull();
});

test("auto-upgrade on: the card says the host installs it alone and keeps the manual command", () => {
  const { container } = render(<I18nProvider><ConnectorUpgradeNotice connector={available} connected autoUpgrade /></I18nProvider>);
  expect(screen.getByText(/Mise à jour automatique active/)).toBeTruthy();
  expect(screen.getByText("sudo edge-setup upgrade --yes")).toBeTruthy();
  expect(screen.queryByText(AUTO_UPGRADE_COMMAND)).toBeNull();
  expect(container.querySelector('[data-auto-upgrade="off"]')).toBeNull();
});

test("no card while the connector is current, whatever auto-upgrade says", () => {
  const current = { ...available, latestVersion: "v1.5.1", updateAvailable: false };
  const { container } = render(<I18nProvider><ConnectorUpgradeNotice connector={current} connected autoUpgrade={false} /></I18nProvider>);
  expect(container.textContent).toBe("");
});

test("English copy", () => {
  window.localStorage.setItem("openedbot:locale", "en");
  render(<I18nProvider><ConnectorUpgradeNotice connector={available} connected autoUpgrade={false} /></I18nProvider>);
  expect(screen.getByText("Automatic updates are off")).toBeTruthy();
});
