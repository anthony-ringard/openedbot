import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconRefresh } from "@tabler/icons-react";
import { cn, toast } from "@openedbot/browser-ui-kit";
import { api, errorMessage, queryKeys } from "../../../../lib/api";
import { connectorUpgradeLevel, hermesUpdate } from "../../../../lib/runtime/connector-upgrade";
import { AUTO_UPGRADE_COMMAND } from "../../../../lib/runtime/auto-upgrade";
import { useT } from "../../../../lib/i18n";
import type { RuntimeEnrollmentTicketDto, RuntimeLinkVerifyDto, RuntimeConnectorDto, RuntimeLinkDto, RuntimePublicDto } from "@openedbot/contracts-api";
import { ACTIONS, BUTTON, CopyButton, Note } from "../../../../components/settings/primitives";
import { RuntimeEnrollmentDialog } from "./cloud-enrollment";

/**
 * Au plus une minute et quart pour qu'un hôte raccroché revienne : un
 * connecteur à jour redial en une seconde, un ancien garde son backoff (60 s
 * au plus).
 */
const LINK_RECONNECT_WAIT_MS = 75_000;

/** « Réessayer » sur un lien fermé : passé ce délai sans lien, c'est un échec. */
const LINK_RETRY_WAIT_MS = 5_000;

type LinkCheck =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "reconnecting"; previousGeneration: string | null }
  | { phase: "retrying" }
  | { phase: "done"; result: RuntimeLinkVerifyDto; repaired: boolean }
  | { phase: "waiting" }
  | { phase: "retry_failed" };

/**
 * « Vérifier le lien » : un seul geste, qui décide seul. Ping WebSocket du
 * lien, puis sonde du gateway s'il répond. Un lien muet est raccroché par openedbot
 * (4005) : l'écran attend que l'hôte revienne sous une NOUVELLE génération,
 * puis revérifie. `connected` ne prouverait rien : il vaut déjà `true` avant
 * la coupure, et la relecture peut ne jamais voir le `false`.
 */

export function RuntimeLinkCheck({ runtime, retiredOrigin = null }: { runtime: RuntimePublicDto; retiredOrigin?: string | null }) {
  const { t, formatDate } = useT();
  const queryClient = useQueryClient();
  const [check, setCheck] = useState<LinkCheck>({ phase: "idle" });
  const { mutate: runVerify } = useMutation({
    mutationFn: (_input: { repaired: boolean; retry: boolean }) => {
      if (!runtime.id) throw new Error("runtime");
      return api.verifyRuntimeLink(runtime.id);
    },
    onMutate: () => setCheck({ phase: "checking" }),
    onSuccess: (result, input) => {
      if (result.outcome === "reconnect_requested") {
        setCheck({ phase: "reconnecting", previousGeneration: result.generation });
        return;
      }
      // L'hôte s'est reconnecté pendant la lecture : on sonde la connexion qui tient le lien.
      if (result.outcome === "generation_changed" && input.retry) {
        runVerify({ repaired: input.repaired, retry: false });
        return;
      }
      setCheck({ phase: "done", result, repaired: input.repaired });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration });
    },
    onError: (error) => {
      setCheck({ phase: "idle" });
      toast.error(errorMessage(error, t("cloudRuntimeSettings.linkVerifyFailed")));
    },
  });

  const waitingFor = check.phase === "reconnecting" || check.phase === "retrying" ? check.phase : null;
  useEffect(() => {
    if (waitingFor === null) return;
    // La relecture habituelle bat toutes les 5 s : trop lent pour un redial d'une seconde.
    const poll = setInterval(() => void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration }), 1_000);
    const giveUp =
      waitingFor === "retrying"
        ? setTimeout(() => setCheck({ phase: "retry_failed" }), LINK_RETRY_WAIT_MS)
        : setTimeout(() => setCheck({ phase: "waiting" }), LINK_RECONNECT_WAIT_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(giveUp);
    };
  }, [waitingFor, queryClient]);

  const generation = runtime.link?.connected ? runtime.link.generation ?? "connected" : null;
  const previousGeneration = check.phase === "reconnecting" ? check.previousGeneration : undefined;
  useEffect(() => {
    if (generation === null) return;
    // Un lien qui revient après l'abandon des 5 s remplace l'échec par le verdict réel.
    if (check.phase === "retrying" || check.phase === "retry_failed") {
      runVerify({ repaired: true, retry: true });
      return;
    }
    if (previousGeneration === undefined || generation === previousGeneration) return;
    runVerify({ repaired: true, retry: true });
  }, [check.phase, generation, previousGeneration, runVerify]);

  const doctor = <code className="font-mono">sudo edge-setup doctor</code>;
  const startRetry = (): void => {
    setCheck({ phase: "retrying" });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration });
  };
  let verdict: ReactNode = null;
  if (check.phase === "checking") {
    verdict = <Note role="status">{t("cloudRuntimeSettings.linkVerifyChecking")}</Note>;
  } else if (check.phase === "reconnecting") {
    verdict = <Note tone="info" role="status">{t("cloudRuntimeSettings.linkVerifyReconnecting")}</Note>;
  } else if (check.phase === "retrying") {
    verdict = <Note tone="info" role="status">{t("cloudRuntimeSettings.linkRetrying")}</Note>;
  } else if (check.phase === "retry_failed") {
    verdict = retiredOrigin ? (
      <Note tone="danger" role="alert">{t("cloudRuntimeSettings.linkOriginRetiredRetry", { origin: retiredOrigin })}</Note>
    ) : (
      <Note tone="danger" role="alert">
        <span className="block">{t("cloudRuntimeSettings.linkRetryFailed")} {doctor}</span>
        <span className="block">{t("cloudRuntimeSettings.linkVerifyDoctorHint")}</span>
      </Note>
    );
  } else if (check.phase === "waiting") {
    verdict = (
      <Note tone="warning" role="status">
        <span className="block">{t("cloudRuntimeSettings.linkVerifyWaiting")} {doctor}</span>
        <span className="block">{t("cloudRuntimeSettings.linkVerifyDoctorHint")}</span>
      </Note>
    );
  } else if (check.phase === "done") {
    const { result, repaired } = check;
    if (result.outcome === "alive") {
      const linkLine = repaired
        ? t("cloudRuntimeSettings.linkVerifyRepaired")
        : result.rttMs === null
          ? t("cloudRuntimeSettings.linkVerifyAliveBusy")
          : t("cloudRuntimeSettings.linkVerifyAlive", { rtt: String(result.rttMs) });
      verdict = (
        <Note tone={result.gateway?.ok === false ? "warning" : "success"} role="status">
          <span className="block">{linkLine}</span>
          <span className="block">
            {result.gateway?.ok === false
              ? t("cloudRuntimeSettings.linkVerifyGatewayFailed", { message: result.gateway.message })
              : t("cloudRuntimeSettings.linkVerifyGatewayOk")}
          </span>
        </Note>
      );
    } else if (result.outcome === "no_link") {
      verdict = (
        <Note tone="warning" role="status">
          <span className="block">{t("cloudRuntimeSettings.linkVerifyUnreachable")} {doctor}</span>
          <span className="block">{t("cloudRuntimeSettings.linkVerifyDoctorHint")}</span>
          {result.lastSeenAt ? (
            <span className="block">{t("cloudRuntimeSettings.linkVerifyLastSeen", { date: formatDate(result.lastSeenAt) })}</span>
          ) : null}
        </Note>
      );
    } else if (result.outcome === "owner_unavailable") {
      verdict = <Note tone="warning" role="status">{t("cloudRuntimeSettings.linkVerifyOwnerUnavailable")}</Note>;
    } else {
      verdict = <Note role="status">{t("cloudRuntimeSettings.linkVerifyIndeterminate")}</Note>;
    }
  }

  const busy = check.phase === "checking" || check.phase === "reconnecting" || check.phase === "retrying";
  const isClosed = runtime.link?.connected !== true;
  const showClosedHint = isClosed && check.phase === "idle" && !retiredOrigin;
  return (
    <div className="space-y-3">
      <div className={ACTIONS}>
        <button
          type="button"
          className={cn(BUTTON.secondary, "gap-2", busy && "[&_svg]:animate-spin")}
          disabled={busy}
          onClick={isClosed ? startRetry : () => runVerify({ repaired: false, retry: true })}
        >
          <IconRefresh className="size-4" aria-hidden /> {t(isClosed ? "cloudRuntimeSettings.linkRetry" : "cloudRuntimeSettings.linkVerify")}
        </button>
      </div>
      {showClosedHint ? (
        <Note tone="warning" role="status">
          <span className="block">{t("cloudRuntimeSettings.linkClosedHint")}</span>
          <span className="block">{t("cloudRuntimeSettings.linkClosedDoctorHint")} {doctor}</span>
          {runtime.link?.lastSeenAt ? (
            <span className="block">{t("cloudRuntimeSettings.linkVerifyLastSeen", { date: formatDate(runtime.link.lastSeenAt) })}</span>
          ) : null}
        </Note>
      ) : null}
      {verdict}
    </div>
  );
}

/**
 * The host's connector is behind. openedbot cannot upgrade it (release boundary):
 * the card hands the owner the one command to run on the host. Below the
 * minimum is a warning, a newer release alone is information.
 */
export function ConnectorUpgradeNotice({ connector, connected, autoUpgrade }: {
  connector: RuntimeConnectorDto | null | undefined;
  connected: boolean;
  /** L'hôte annonce `auto_upgrade` : il installera cette version seul. */
  autoUpgrade: boolean;
}) {
  const { t } = useT();
  const level = connectorUpgradeLevel(connector);
  if (!connector || !level) return null;
  const target = connector.latestVersion ?? connector.minimumVersion ?? t("connectorUpgrade.unknownVersion");
  return (
    <Note tone={level === "outdated" ? "warning" : "info"} role="status" className="space-y-2">
      <span className="block font-medium">
        {t(level === "outdated" ? "connectorUpgrade.outdatedTitle" : "connectorUpgrade.availableTitle")}
      </span>
      <span className="block">
        {t("connectorUpgrade.versions", { installed: connector.version ?? connector.agent, target })}
      </span>
      {autoUpgrade ? (
        <span data-auto-upgrade="on" className="block">{t("connectorUpgrade.autoActive")}</span>
      ) : null}
      <NoticeCommand command={connector.upgradeCommand} />
      <span className="block">{t(connected ? "connectorUpgrade.selfServe" : "connectorUpgrade.selfServeClosed")}</span>
      {autoUpgrade ? null : (
        <span data-auto-upgrade="off" className="block space-y-2 border-t border-current/15 pt-2">
          <span className="block font-medium">{t("connectorUpgrade.autoOffTitle")}</span>
          <span className="block">{t("connectorUpgrade.autoOffHelp")}</span>
          <NoticeCommand command={AUTO_UPGRADE_COMMAND} />
        </span>
      )}
    </Note>
  );
}

function NoticeCommand({ command }: { command: string }) {
  const { t } = useT();
  return (
    <span className="flex items-center gap-2">
      <code className="scrollbar-subtle block min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-surface-sunken px-3 py-2 font-mono text-xs leading-5 text-foreground">
        {command}
      </code>
      <CopyButton
        value={command}
        copyLabel={t("connectorUpgrade.copy")}
        copiedLabel={t("connectorUpgrade.copied")}
        className={cn(BUTTON.small, "shrink-0")}
      />
    </span>
  );
}

/**
 * A newer Hermes ships with the latest edge-setup release. Information only:
 * Hermes is updated with edge-setup, on the host, and openedbot never runs it.
 */
export function HermesUpdateNotice({ link }: { link: RuntimeLinkDto | null | undefined }) {
  const { t } = useT();
  const update = hermesUpdate(link);
  if (!update) return null;
  return (
    <Note tone="info" role="status" className="space-y-2">
      <span className="block font-medium">{t("connectorUpgrade.hermesTitle")}</span>
      <span className="block">{t("connectorUpgrade.hermesVersions", { current: update.current!, latest: update.latest! })}</span>
      <CommandLine title={t("connectorUpgrade.dialogUpgrade")} command={update.upgradeCommand} />
      <span className="block">{t("connectorUpgrade.hermesHow")}</span>
    </Note>
  );
}

function CommandLine({ title, command }: { title: string; command: string }) {
  const { t } = useT();
  return (
    <span className="block space-y-1">
      <span className="block font-medium">{title}</span>
      <span className="flex items-center gap-2">
        <code className="scrollbar-subtle block min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-surface-sunken px-3 py-2 font-mono text-xs leading-5 text-foreground">
          {command}
        </code>
        <CopyButton
          value={command}
          copyLabel={t("connectorUpgrade.copy")}
          copiedLabel={t("connectorUpgrade.copied")}
          className={cn(BUTTON.small, "shrink-0")}
        />
      </span>
    </span>
  );
}

/**
 * The host's last signed origin is no longer accepted. `upgrade` reconnects
 * to that same origin, so it cannot bring the link back: the card says so
 * and hands the owner a fresh enrollment ticket plus the current command.
 */
export function RetiredLinkNotice({ runtime }: { runtime: RuntimePublicDto }) {
  const { t } = useT();
  const origin = runtime.link?.origin ?? null;
  const command = runtime.link?.relinkCommand ?? null;
  const upgrade = runtime.link?.connector?.upgradeCommand ?? "sudo edge-setup upgrade --yes";
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const readOnly = Boolean(me.data?.session.impersonation);
  const [ticket, setTicket] = useState<RuntimeEnrollmentTicketDto | null>(null);
  const enroll = useMutation({
    mutationFn: () => api.openRuntimeEnrollment({ name: runtime.name?.trim() || "runtime" }),
    onSuccess: (opened) => setTicket(opened),
    onError: (error) => toast.error(errorMessage(error, t("cloudRuntimeSettings.linkOriginRetiredFailed"))),
  });
  if (!origin || !command || runtime.link?.originRetired !== true) return null;
  return (
    <>
      <Note tone="danger" role="alert" className="space-y-3">
        <span className="block font-medium">{t("cloudRuntimeSettings.linkOriginRetiredTitle")}</span>
        <span className="block">{t("cloudRuntimeSettings.linkOriginRetiredBody", { origin })}</span>
        <CommandLine title={t("cloudRuntimeSettings.linkOriginRetiredStepUpgrade")} command={upgrade} />
        <span className="block space-y-2">
          <span className="block font-medium">{t("cloudRuntimeSettings.linkOriginRetiredStepTicket")}</span>
          <span className="block">{t("cloudRuntimeSettings.linkOriginRetiredTicketHelp")}</span>
          {readOnly ? (
            <span className="block">{t("cloudRuntimeSettings.linkOriginRetiredTicketReadonly")}</span>
          ) : (
            <button type="button" className={BUTTON.primary} disabled={enroll.isPending} onClick={() => enroll.mutate()}>
              {enroll.isPending ? t("cloudRuntimeSettings.linkOriginRetiredTicketBusy") : t("cloudRuntimeSettings.linkOriginRetiredTicket")}
            </button>
          )}
        </span>
        <CommandLine title={t("cloudRuntimeSettings.linkOriginRetiredStepRelink")} command={command} />
      </Note>
      {ticket ? (
        <RuntimeEnrollmentDialog ticket={ticket} onDone={() => setTicket(null)} onCancel={() => setTicket(null)} />
      ) : null}
    </>
  );
}
