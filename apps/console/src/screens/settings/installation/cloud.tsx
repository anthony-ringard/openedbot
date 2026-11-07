import { RuntimeDirectActions, RuntimeDirectStatus } from "../../../components/runtime-direct";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconShieldExclamation } from "@tabler/icons-react";
import { cn, toast, useIsMobile } from "@openedbot/browser-ui-kit";
import { api, errorMessage, queryKeys } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import type { RuntimeLinkRotationDto, RuntimePublicDto } from "@openedbot/contracts-api";
import { InsetGroupedSection, InsetGroupedStatic } from "../../../components/mobile/inset-grouped";
import { SettingsPane } from "../pane";
import {
  ACTIONS,
  BUTTON,
  CardHeading,
  Note,
  SectionHeading,
  SettingsCard,
  StatusList,
  StatusRow,
  ToneBadge,
} from "../../../components/settings/primitives";
import { ProviderIncidentDialog } from "../../../components/provider-incident-banner";
import { RUNTIME_DISCONNECTED_REFETCH_MS, RUNTIME_REFETCH_MS, type RuntimeSection } from "./cloud/cloud-shared";
import { CopyableCommand } from "./cloud/cloud-token-help";
import { RuntimeFormSkeleton, RuntimeOwnershipHelp, RuntimeSectionRail } from "./cloud/cloud-runtime-chrome";
import { RuntimeLinkHero } from "./cloud/cloud-link-hero";
import { hasAutoUpgrade } from "../../../lib/runtime/auto-upgrade";
import { ConnectorUpgradeNotice, HermesUpdateNotice, RetiredLinkNotice, RuntimeLinkCheck } from "./cloud/cloud-link-check";
import { ConnectorReleaseNotesButton } from "../../../components/connector-update-dialog";
import { linkHealthErrorText } from "../../../lib/runtime/link-health-error";
import { RuntimeRemoval, RuntimeReplacement } from "./cloud/cloud-registry";
import { RuntimeTerminalSwitch } from "./cloud/cloud-terminal-switch";
import { RuntimeAlertsSection } from "./cloud/cloud-alerts";

export { isRuntimeSection, type RuntimeSection } from "./cloud/cloud-shared";
export { HermesTokenHelpDialog } from "./cloud/cloud-token-help";
export { CloudSettingsOverview } from "./cloud/cloud-overview";
export { RuntimeReplacement } from "./cloud/cloud-registry";

export function CloudRuntimeSettings({
  section,
  onSectionChange,
}: {
  /** La section ouverte, quand l'URL la porte. Sinon l'écran la tient lui-même. */
  section?: RuntimeSection;
  onSectionChange?: (section: RuntimeSection) => void;
}) {
  const configuration = useQuery({
    queryKey: queryKeys.runtimeConfiguration,
    queryFn: api.runtimeConfiguration,
    refetchInterval: (query) => query.state.data?.runtime?.link?.connected === false
      ? RUNTIME_DISCONNECTED_REFETCH_MS
      : RUNTIME_REFETCH_MS,
  });
  if (configuration.isPending) return <SettingsPane><RuntimeFormSkeleton /></SettingsPane>;
  if (configuration.error || !configuration.data) {
    return (
      <RuntimeConnectionForm
        runtime={null}
        loadError="Impossible de lire la configuration du runtime. Les valeurs ci-dessous ne sont pas enregistrées."
        section={section}
        onSectionChange={onSectionChange}
      />
    );
  }
  return (
    <RuntimeConnectionForm
      key={configuration.data.runtime?.id ?? "new"}
      runtime={configuration.data.runtime}
      section={section}
      onSectionChange={onSectionChange}
    />
  );
}

function RuntimeConnectionForm({
  runtime,
  loadError,
  section,
  onSectionChange,
}: {
  runtime: RuntimePublicDto | null;
  loadError?: string;
  section?: RuntimeSection;
  onSectionChange?: (section: RuntimeSection) => void;
}) {
  const { t, formatDate } = useT();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  // Le jeton neuf n'existe que dans cet état, le temps de le copier : il n'est
  // ni mis en cache par la requête, ni relisible après un rechargement.
  const [issuedLink, setIssuedLink] = useState<RuntimeLinkRotationDto | null>(null);
  // Soupçon de détournement : la connexion ouverte peut être celle du
  // détourneur, donc rotation d'urgence : aucune grâce, aucun push, lien coupé.
  const hijackSuspectedAt = runtime?.reachability === "connector" ? runtime.link?.hijackSuspectedAt ?? null : null;
  const rotate = useMutation({
    mutationFn: () => {
      if (!runtime?.id) throw new Error("runtime");
      return api.rotateRuntimeLinkToken(runtime.id, "emergency");
    },
    onSuccess: async (issued) => {
      setIssuedLink(issued);
      await queryClient.invalidateQueries({ queryKey: queryKeys.runtime });
      await queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration });
      toast.success(t("cloudRuntimeSettings.rotateLinkTokenSuccess"));
    },
    onError: (error) => toast.error(errorMessage(error, t("cloudRuntimeSettings.rotateLinkTokenFailed"))),
  });
  // Un runtime `connector` n'a ni URL ni token côté cloud, et PUT /api/runtime
  // le refuse (409 RUNTIME_REACHABILITY_IMMUTABLE) : l'écran ne promet donc
  // aucune édition : seules la lecture et la sonde restent.
  const isConnectorRuntime = runtime?.reachability === "connector";
  // Le jeton affiché ne survit ni à la boîte fermée ni à l'écran quitté.
  const dismissIssuedLink = (): void => {
    setIssuedLink(null);
    rotate.reset();
  };
  const resetRotation = rotate.reset;
  useEffect(() => () => {
    resetRotation();
  }, [resetRotation]);

  // Le compteur du rail : un remplaçant qui attend, visible sans ouvrir la
  // section. Même clé que la section, donc une seule requête.
  const registry = useQuery({ queryKey: queryKeys.runtimeList, queryFn: api.runtimeList, refetchInterval: RUNTIME_REFETCH_MS });
  const pendingCount = registry.data?.filter((entry) => !entry.isActive).length ?? 0;
  // Sans runtime déclaré, « État » n'a rien à raconter : on ne propose pas un
  // onglet qui ne mènerait qu'à du vide.
  const sections: { id: RuntimeSection; label: string; count?: number }[] = [
    ...(runtime ? [{ id: "status" as const, label: "État" }] : []),
    // Les alertes disent qu'un runtime est KO : sans runtime, rien à surveiller.
    ...(runtime ? [{ id: "alerts" as const, label: t("runtimeAlerts.tab") }] : []),
    {
      id: "runtimes",
      label: t(runtime ? "cloudRuntimeSettings.replaceAction" : "cloudRuntimeSettings.addAction"),
      ...(pendingCount > 0 ? { count: pendingCount } : {}),
    },
  ];
  // Sans runtime, on arrive sur l'ajout : c'est la seule chose à faire.
  const fallbackSection: RuntimeSection = !runtime ? "runtimes" : "status";
  const [localSection, setLocalSection] = useState<RuntimeSection | null>(null);
  const requested = section ?? localSection;
  const currentSection = requested && sections.some((entry) => entry.id === requested) ? requested : fallbackSection;
  const goTo = (next: RuntimeSection): void => {
    setLocalSection(next);
    onSectionChange?.(next);
  };

  // La rotation n'est plus une action de maintenance courante : sur un lien
  // sain, le jeton est entièrement géré par le workflow d'appairage. On ne
  // l'expose que comme réponse explicite à un détournement soupçonné.
  const rotateButton = isConnectorRuntime && hijackSuspectedAt ? (
    <button
      type="button"
      className={cn(BUTTON.primary, "min-h-11")}
      disabled={!runtime?.id || rotate.isPending}
      onClick={() => rotate.mutate()}
    >
      {t("cloudRuntimeSettings.rotateLinkTokenEmergency")}
    </button>
  ) : null;
  // Le retrait se pose à côté de « Tester » : c'est la carte qui décrit CE
  // runtime, donc l'endroit où on le cherche. La section Remplacer en offre
  // un second, sur la carte du remplaçant en attente.
  const actions = runtime ? (
    <>
      {runtime.reachability === "direct" ? <RuntimeDirectActions runtime={runtime} /> : null}
      {rotateButton}
      <RuntimeRemoval runtime={runtime} />
    </>
  ) : null;
  // Bandeau « lien remplacé depuis une autre adresse » : Inset Grouped, une
  // phrase, jamais tronquée ; le geste de réponse est le bouton de rotation.
  const hijackBanner = hijackSuspectedAt ? (
    <InsetGroupedSection className="bg-card px-0 pt-0">
      <InsetGroupedStatic
        icon={IconShieldExclamation}
        label={t("cloudRuntimeSettings.linkHijackTitle")}
        value={t("cloudRuntimeSettings.linkHijackBanner", { date: formatDate(hijackSuspectedAt) })}
        multiline
      />
      <InsetGroupedStatic value={t("cloudRuntimeSettings.rotateLinkTokenEmergencyHint")} label="" multiline />
    </InsetGroupedSection>
  ) : null;
  // Le jeton neuf, une seule fois, copiable, puis plus jamais.
  const issuedLinkBox = issuedLink ? (
    <div role="status" className="space-y-2 rounded-xl border border-border bg-surface-sunken/40 p-4">
      <CopyableCommand label={t("cloudRuntimeSettings.rotatedLinkTokenLabel")} value={issuedLink.linkToken} />
      <p className="text-xs text-muted-foreground">
        {issuedLink.mode === "emergency"
          ? t("cloudRuntimeSettings.rotatedLinkTokenEmergencyOnce")
          : t("cloudRuntimeSettings.rotatedLinkTokenOnce", {
              // Sans date d'expiration lisible, la phrase reste vraie sans
              // promettre une échéance que l'API n'a pas publiée.
              date: issuedLink.expiresPreviousAt ? formatDate(issuedLink.expiresPreviousAt) : "son expiration",
            })}
      </p>
      <div className={ACTIONS}>
        <button type="button" className={BUTTON.secondary} onClick={dismissIssuedLink}>
          {t("cloudRuntimeSettings.dismissRotatedLinkToken")}
        </button>
      </div>
    </div>
  ) : null;
  // Section « État » : les faits derrière le fil. Le hero dit si le lien est
  // ouvert ; ici, ce qu’openedbot en sait de plus, et à qui appartient la machine.
  const retired = runtime?.link?.originRetired === true && Boolean(runtime.link.origin);
  const healthError = linkHealthErrorText(
    runtime?.lastHealthError,
    runtime?.link?.lastSeenAt,
    (seen) => t("cloudRuntimeSettings.linkClosedAfterRestart", { date: formatDate(seen) }),
  );
  const statusSection = (
    <>
      {runtime?.reachability === "direct" ? <RuntimeDirectStatus runtime={runtime} /> : null}
      {isConnectorRuntime && runtime ? (
        <SettingsCard className="space-y-4">
          <CardHeading
            title="Lien connecteur"
            description="Ce qu’openedbot sait de la connexion sortante de cet hôte."
          />
          <StatusList className={cn(!isMobile && "rounded-xl border border-border")}>
            {/* Colonne droite en pastilles : chaque fait porte son ton, donc
                l'état du lien se lit à la couleur avant de se lire au mot. */}
            <StatusRow label="Joignabilité" value={<ToneBadge tone="info">Connexion sortante</ToneBadge>} />
            <StatusRow
              label="Lien ouvert"
              value={runtime.link?.connected ? (
                <ToneBadge tone="success">oui</ToneBadge>
              ) : (
                <ToneBadge tone="warning">non</ToneBadge>
              )}
            />
            {/* Le dernier signe de vie est déjà sous le fil : ici il tronquait à 390 px. */}
            {runtime.link?.rotatedAt ? (
              <StatusRow
                label="Jeton de lien"
                value={(
                  <ToneBadge tone="neutral">
                    {t("cloudRuntimeSettings.linkRotatedAt", { date: formatDate(runtime.link.rotatedAt) })}
                  </ToneBadge>
                )}
              />
            ) : null}
            {runtime.lastCheckedAt ? (
              <StatusRow
                label="Dernier test"
                value={<ToneBadge tone="neutral">{formatDate(runtime.lastCheckedAt)}</ToneBadge>}
              />
            ) : null}
            {healthError ? (
              <StatusRow
                label="Dernière erreur"
                value={(
                  // Une phrase, pas une étiquette : la pastille doit pouvoir
                  // revenir à la ligne, sinon `whitespace-nowrap` la rogne.
                  <ToneBadge tone="danger" className="items-start whitespace-normal px-2.5 py-1 text-left font-mono">
                    {healthError}
                  </ToneBadge>
                )}
              />
            ) : null}
          </StatusList>
          {retired ? (
            <RetiredLinkNotice runtime={runtime} />
          ) : (
            <>
              <ConnectorUpgradeNotice
                connector={runtime.link?.connector}
                connected={runtime.link?.connected === true}
                autoUpgrade={hasAutoUpgrade(runtime.linkFeatures)}
              />
              <HermesUpdateNotice link={runtime.link} />
            </>
          )}
          <RuntimeLinkCheck key={runtime.id} runtime={runtime} retiredOrigin={retired ? runtime.link?.origin ?? null : null} />
        </SettingsCard>
      ) : null}
      {runtime?.id ? <RuntimeTerminalSwitch runtimeId={runtime.id} /> : null}
      <ProviderIncidentDialog incidents={runtime?.providerIncidents} />
    </>
  );

  return (
    <SettingsPane footer={isMobile && currentSection !== "runtimes" && actions ? actions : undefined}>
      <SectionHeading
        title={t("settingsSidebar.runtime")}
        description="Choisissez comment openedbot joint votre runtime : lien sortant ou accès direct à votre charge."
        action={runtime ? (
          <div className="flex items-center gap-2">
            {runtime.link?.connector ? <ConnectorReleaseNotesButton /> : null}
            <RuntimeOwnershipHelp runtime={runtime} />
          </div>
        ) : undefined}
      />
      {loadError ? <Note tone="danger" role="alert">{loadError}</Note> : null}
      <RuntimeLinkHero
        runtime={runtime}
        actions={actions}
      >
        {hijackBanner}
        {issuedLinkBox}
      </RuntimeLinkHero>
      <RuntimeSectionRail sections={sections} current={currentSection} onChange={goTo}>
        {currentSection === "status" ? statusSection : null}
        {currentSection === "alerts" ? <RuntimeAlertsSection /> : null}
        {currentSection === "runtimes" ? <RuntimeReplacement activeId={runtime?.id ?? null} /> : null}
      </RuntimeSectionRail>
    </SettingsPane>
  );
}
