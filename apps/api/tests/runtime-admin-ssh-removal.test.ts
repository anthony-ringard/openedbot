import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readApiConfig } from "../src/infrastructure/config";
import { effectiveAdminMode } from "@openedbot/runtimes/application/runtime-mode";
import type { ApiConfig } from "../src/infrastructure/config";

/**
 * La frontière produit est « on n'administre pas le Hermes du client ».
 * Elle était tenue par une variable d'environnement au-dessus de 794 lignes de
 * code privilégié : une session SSH depuis l'hôte API vers la machine de chaque
 * client. Ces tests la tiennent par le code.
 *
 * Le canal `local` reste accepté pour compatibilité d'environnement, mais
 * aucun runtime intégré n'est administré par openedbot.
 */

const sourceRoots = [
  new URL("../src", import.meta.url).pathname,
  new URL("../../console/src", import.meta.url).pathname,
  new URL("../../worker/src", import.meta.url).pathname,
  new URL("../../../modules", import.meta.url).pathname,
  new URL("../../../contracts", import.meta.url).pathname,
  new URL("../../../browser", import.meta.url).pathname,
  new URL("../../../platform", import.meta.url).pathname,
];

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (/\.(ts|tsx)$/u.test(entry.name)) found.push(path);
    }
  };
  walk(root);
  return found;
}

const allSources = sourceRoots.flatMap(sourceFiles);

describe("Aucun canal shell vers un hôte client", () => {
  test("aucune source n'ouvre de session SSH", () => {
    const offenders = allSources.filter((path) => {
      if (path.endsWith("runtime-admin-ssh-removal.test.ts")) return false;
      return /Bun\.spawn\(\s*\[\s*"ssh"/u.test(readFileSync(path, "utf8"));
    });
    expect(offenders).toEqual([]);
  });

  test("la surface admin-channel n'existe plus", () => {
    const offenders = allSources.filter((path) => {
      if (path.endsWith("runtime-admin-ssh-removal.test.ts")) return false;
      return readFileSync(path, "utf8").includes("admin-channel");
    });
    expect(offenders).toEqual([]);
  });

  test("le module de cible SSH a disparu", () => {
    expect(() => readFileSync(
      new URL("../src/infrastructure/runtime-ssh.ts", import.meta.url).pathname,
      "utf8",
    )).toThrow();
  });

  test("aucune source ne parle encore d'une clé d'administration openedbot", () => {
    const offenders = allSources.filter((path) => {
      if (path.endsWith("runtime-admin-ssh-removal.test.ts")) return false;
      return readFileSync(path, "utf8").includes("openedbot_admin");
    });
    expect(offenders).toEqual([]);
  });
});

describe("La configuration n'ouvre aucun canal SSH", () => {
  const base = {
    OPENEDBOT_ENV: "development",
    RUNTIME_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    METRICS_INTERNAL_TOKEN: "metrics-secret",
  };

  test("aucun canal d'administration ne s'ouvre, quel que soit l'environnement", () => {
    for (const environment of ["development", "test"]) {
      const config = readApiConfig({ ...base, OPENEDBOT_ENV: environment });
      expect(config.runtimeAdminChannels.local).toBe(false);
    }
  });
});

describe("Un runtime externe n'a plus de canal d'administration", () => {
  const config = { runtimeAdminChannels: { local: true } } as unknown as ApiConfig;

  test("le mode externe retombe sur disabled", () => {
    expect(effectiveAdminMode(config, "external")).toBe("disabled");
  });

});

describe("La cible SSH quitte le schéma", () => {
  test("la migration retire les trois colonnes et s'enregistre", () => {
    const sql = readFileSync(
      new URL("../../../db/migrations/0022_drop_runtime_ssh.sql", import.meta.url),
      "utf8",
    );
    for (const column of ["ssh_host", "ssh_port", "ssh_user"]) {
      expect(sql).toContain(`drop column if exists ${column}`);
    }
    expect(sql).toContain("insert into schema_migrations(version) values ('0022_drop_runtime_ssh')");
  });
});
