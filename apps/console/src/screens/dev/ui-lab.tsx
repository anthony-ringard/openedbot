/**
 * `/dev/ui` (dev only, mounted by `route-tree.tsx` under
 * `import.meta.env.DEV === true`): a bench to try shared UI pieces by hand,
 * in light and dark, without reproducing the situation that shows them.
 * Toasts first; a new preview is one more `LabSection`. Nothing here calls
 * the API or a runtime.
 */
import type { ReactNode } from "react";
import { cn, toast } from "@openedbot/browser-ui-kit";
import { THEME_MODES, useTheme, type ThemeMode } from "@openedbot/browser-ui-kit/theme";
import { BUTTON } from "../../components/settings/primitives";
import { useT } from "../../lib/i18n";

const MODE_LABELS: Record<ThemeMode, string> = { light: "Clair", dark: "Sombre", system: "Système" };

function LabSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border bg-card p-5">
      <header className="space-y-0.5">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </header>
      <div className="flex flex-wrap gap-2">{children}</div>
    </section>
  );
}

function LabButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className={BUTTON.secondary} onClick={onClick}>{label}</button>;
}

function ThemeSwitch() {
  const theme = useTheme();
  return (
    <div role="radiogroup" aria-label="Thème" className="inline-flex rounded-full bg-[var(--control)] p-0.5">
      {THEME_MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={theme.mode === mode}
          onClick={() => theme.setMode(mode)}
          className={cn(
            "h-7 rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors",
            theme.mode === mode && "bg-[var(--control-active)] text-foreground shadow-[var(--shadow-xs)]",
          )}
        >
          {MODE_LABELS[mode]}
        </button>
      ))}
    </div>
  );
}

const wait = (ms: number, fail = false) =>
  new Promise<void>((resolve, reject) => window.setTimeout(() => (fail ? reject(new Error("refusé")) : resolve()), ms));

export function UiLabScreen() {
  const { t } = useT();
  const runtimeUpToDate = () =>
    toast.success(t("connectorUpgrade.upToDateTitle"), {
      id: "lab:connector-up-to-date",
      description: t("connectorUpgrade.upToDate", { version: "v1.5.1", runtime: "vps prod pve 241" }),
      duration: 8_000,
    });

  return (
    <div className="mx-auto h-full w-full max-w-3xl space-y-4 overflow-y-auto px-6 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">UI lab</h1>
          <p className="text-sm text-muted-foreground">Développement seulement : rien n'appelle l'API.</p>
        </div>
        <ThemeSwitch />
      </header>

      <LabSection title="Toasts" hint="Le Toaster partagé de la console, en bas à droite. Survol : la pile se déploie et le minuteur s'arrête.">
        <LabButton label="Runtime à jour" onClick={runtimeUpToDate} />
        <LabButton label="Succès" onClick={() => toast.success("Bot créé", { description: "Atlas est prêt dans l'espace de travail." })} />
        <LabButton label="Info" onClick={() => toast.info("Nouvelle version disponible", { description: "edge-setup v1.5.2 est publié." })} />
        <LabButton label="Avertissement" onClick={() => toast.warning("Quota bientôt atteint", { description: "90 % du crédit du mois est consommé." })} />
        <LabButton label="Erreur" onClick={() => toast.error("Le runtime ne répond pas", { description: "Dernier signal il y a 4 min." })} />
        <LabButton label="Neutre" onClick={() => toast("Lien copié")} />
        <LabButton
          label="Avec action"
          onClick={() => toast("Conversation archivée", { action: { label: "Annuler", onClick: () => toast.success("Conversation restaurée") } })}
        />
        <LabButton
          label="Promesse (ok)"
          onClick={() => void toast.promise(wait(1_800), { loading: "Enregistrement…", success: "Enregistré", error: "Échec" }).catch(() => undefined)}
        />
        <LabButton
          label="Promesse (échec)"
          onClick={() => void toast.promise(wait(1_800, true), { loading: "Enregistrement…", success: "Enregistré", error: "Échec de l'enregistrement" }).catch(() => undefined)}
        />
        <LabButton
          label="Texte long"
          onClick={() => toast.info("Une notification au titre volontairement long pour voir le retour à la ligne", {
            description: "Et une description de plusieurs lignes, elle aussi, pour vérifier l'interligne, la largeur et le contraste du texte secondaire.",
          })}
        />
        <LabButton
          label="Rafale ×4"
          onClick={() => ["Premier", "Deuxième", "Troisième", "Quatrième"].forEach((title, index) => window.setTimeout(() => toast(title), index * 150))}
        />
        <LabButton label="Tout fermer" onClick={() => toast.dismiss()} />
      </LabSection>
    </div>
  );
}
