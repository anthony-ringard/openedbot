import { Suspense, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazyRouteComponent } from "@tanstack/react-router";
import { CircleCheck } from "lucide-react";
import { Alert, Dialog, cn } from "@openedbot/browser-ui-kit";
import { canOperateWorkspace, type ConnectorReleaseDto, type RuntimePublicDto } from "@openedbot/contracts-api";
import { api, queryKeys, runtimeQueryOptions } from "../lib/api";
import { connectorUpgradeLevel, type ConnectorUpgradeLevel } from "../lib/runtime/connector-upgrade";
import { useT } from "../lib/i18n";
import { BUTTON, CopyButton } from "./settings/primitives";
import { hasAutoUpgrade } from "../lib/runtime/auto-upgrade";

/** Une release ne bouge pas d'heure en heure : l'API la relit déjà toutes les heures. */
const RELEASE_STALE_MS = 30 * 60_000;
/** La confirmation « runtime à jour » s'efface seule. */
const UP_TO_DATE_MS = 8_000;

/** A runtime may have no name yet: its short id stands in, as on the runtime screen. */
// The release notes' markdown is its own chunk: every app frame mounts the
// announcement, few ever open it (ADR 0001, D1b). Until it arrives, the
// notes show as plain text rather than an empty box.
const SupportMarkdown = lazyRouteComponent(() => import("@openedbot/browser-ui-kit/components/support-markdown"), "SupportMarkdown");

function ReleaseNotes({ body }: { body: string }) {
  return (
    <Suspense fallback={<p className="whitespace-pre-wrap">{body}</p>}>
      <SupportMarkdown body={body} />
    </Suspense>
  );
}

function runtimeLabel(runtime: RuntimePublicDto): string {
  return runtime.name ?? runtime.id?.slice(0, 8) ?? "runtime";
}

/** A required update comes back each session, never more than once per session. */
function outdatedDismissKey(runtimeId: string, target: string): string {
  return `openedbot:connector-update:outdated:${runtimeId}:${target}`;
}

function readSessionFlag(key: string): boolean {
  try {
    return window.sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeSessionFlag(key: string): void {
  try {
    window.sessionStorage.setItem(key, "1");
  } catch {
    // Private mode: the dialog may come back this session, nothing worse.
  }
}

/**
 * Tells the owner, the way a desktop app does, that edge-setup has a new
 * release for their runtime: what changed, the command to run, and how to
 * let the host update itself. openedbot never upgrades the host (release
 * boundary): it only hands over the commands.
 *
 * `available`: once per release and per member, on every device (the API
 * keeps the receipt, 0109). `outdated` (below the minimum): each session.
 * When the next `hello` carries the new version, a short confirmation says so.
 */
export function ConnectorUpdateAnnouncement() {
  const { t } = useT();
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  // Owner or operator with write access, never an impersonation: the one who can run the command.
  const operator = Boolean(me.data?.session.canWrite && canOperateWorkspace(me.data.session.role));
  const runtime = useQuery({ ...runtimeQueryOptions(), enabled: operator });
  const connector = runtime.data?.link?.connector ?? null;
  const level = operator ? connectorUpgradeLevel(connector) : null;
  const release = useQuery({
    queryKey: queryKeys.connectorRelease,
    queryFn: api.connectorRelease,
    enabled: level !== null,
    staleTime: RELEASE_STALE_MS,
  });
  const queryClient = useQueryClient();
  const [closed, setClosed] = useState<string | null>(null);
  const upToDate = useUpToDate(runtime.data ?? null, level);

  const latest = release.data?.release ?? null;
  const target = level === "outdated" ? connector?.minimumVersion ?? null : connector?.latestVersion ?? null;
  const dismissKey = runtime.data?.id && target ? outdatedDismissKey(runtime.data.id, target) : null;
  const open = Boolean(
    runtime.data && connector && target && closed !== target && release.data && (
      level === "outdated"
        ? dismissKey !== null && !readSessionFlag(dismissKey)
        : level === "available" && latest?.version === target && !release.data.seen
    ),
  );

  const close = () => {
    if (!target) return;
    setClosed(target);
    if (level === "outdated") {
      if (dismissKey) writeSessionFlag(dismissKey);
      return;
    }
    void api.markConnectorReleaseSeen(target)
      .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.connectorRelease }))
      .catch(() => undefined);
  };

  return (
    <>
      {open && runtime.data && connector && level && release.data ? (
        <ConnectorUpdateDialog
          level={level}
          runtimeName={runtimeLabel(runtime.data)}
          installed={connector.version ?? connector.agent}
          minimum={connector.minimumVersion}
          target={target!}
          release={latest?.version === target ? latest : null}
          upgradeCommand={release.data.upgradeCommand}
          autoUpgradeCommand={hasAutoUpgrade(runtime.data.linkFeatures) ? null : release.data.autoUpgradeCommand}
          upgradeHelp={runtime.data.link?.originRetired
            ? t("connectorUpgrade.dialogUpgradeHelpRetired")
            : runtime.data.link?.connected
              ? t("connectorUpgrade.dialogUpgradeHelp")
              : t("connectorUpgrade.dialogUpgradeHelpClosed")}
          onClose={close}
        />
      ) : null}
      {upToDate ? <ConnectorUpToDateNotice runtimeName={upToDate.runtimeName} version={upToDate.version} /> : null}
    </>
  );
}

/**
 * The connector was behind, and now announces a version that is not: the
 * owner ran the command (or auto-upgrade did). Said once, then it fades.
 */
function useUpToDate(runtime: RuntimePublicDto | null, level: ConnectorUpgradeLevel | null): { runtimeName: string; version: string } | null {
  const previous = useRef<{ runtimeId: string; version: string | null; level: ConnectorUpgradeLevel | null } | null>(null);
  const [notice, setNotice] = useState<{ runtimeName: string; version: string } | null>(null);
  const version = runtime?.link?.connector?.version ?? null;

  const runtimeId = runtime?.id ?? null;
  const name = runtime ? runtimeLabel(runtime) : null;
  useEffect(() => {
    if (!runtimeId || !name) return;
    const before = previous.current;
    previous.current = { runtimeId, version, level };
    if (!before || before.runtimeId !== runtimeId || !before.level || level || !version || version === before.version) return;
    setNotice({ runtimeName: name, version });
  }, [runtimeId, name, version, level]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), UP_TO_DATE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return notice;
}

function ConnectorUpdateDialog({
  level,
  runtimeName,
  installed,
  minimum,
  target,
  release,
  upgradeCommand,
  autoUpgradeCommand,
  upgradeHelp,
  onClose,
}: {
  level: ConnectorUpgradeLevel;
  runtimeName: string;
  installed: string;
  minimum: string | null;
  target: string;
  release: ConnectorReleaseDto | null;
  upgradeCommand: string;
  /** null quand l'hôte se met déjà à jour seul (`auto_upgrade`). */
  autoUpgradeCommand: string | null;
  upgradeHelp: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const outdated = level === "outdated";
  return (
    <Dialog
      open
      onClose={onClose}
      title={outdated ? t("connectorUpgrade.dialogOutdatedTitle") : t("connectorUpgrade.dialogAvailableTitle", { version: target })}
      description={outdated
        ? t("connectorUpgrade.dialogOutdatedDescription", { runtime: runtimeName, installed, minimum: minimum ?? target })
        : t("connectorUpgrade.dialogDescription", { runtime: runtimeName, installed })}
      closeLabel={t("common.close")}
      className="max-w-2xl"
      footer={
        <>
          <button type="button" className={BUTTON.secondary} onClick={onClose}>{t("connectorUpgrade.dialogLater")}</button>
          <button type="button" className={BUTTON.primary} onClick={onClose}>{t("connectorUpgrade.dialogDone")}</button>
        </>
      }
    >
      <div data-connector-update-dialog="" className="space-y-5 text-sm">
        {release?.notes ? (
          <section className="space-y-2">
            <h3 className="font-medium text-foreground">{t("connectorUpgrade.dialogNotes")}</h3>
            <div className="scrollbar-subtle max-h-[min(40vh,320px)] overflow-y-auto rounded-lg bg-surface-sunken px-3 py-2 text-muted-foreground">
              <ReleaseNotes body={release.notes} />
            </div>
            <a href={release.url} target="_blank" rel="noreferrer" className="inline-block text-sm underline underline-offset-2">
              {t("connectorUpgrade.dialogNotesMore")}
            </a>
          </section>
        ) : null}
        <CommandRow title={t("connectorUpgrade.dialogUpgrade")} help={upgradeHelp} command={upgradeCommand} />
        {autoUpgradeCommand ? (
          <CommandRow title={t("connectorUpgrade.dialogAuto")} help={t("connectorUpgrade.dialogAutoHelp")} command={autoUpgradeCommand} />
        ) : (
          <p data-auto-upgrade="on" className="text-muted-foreground">{t("connectorUpgrade.dialogAutoActive")}</p>
        )}
      </div>
    </Dialog>
  );
}

function CommandRow({ title, help, command }: { title: string; help: string; command: string }) {
  const { t } = useT();
  return (
    <section className="space-y-1.5">
      <h3 className="font-medium text-foreground">{title}</h3>
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
      <p className="text-muted-foreground">{help}</p>
    </section>
  );
}

function ConnectorUpToDateNotice({ runtimeName, version }: { runtimeName: string; version: string }) {
  const { t } = useT();
  return (
    <aside
      data-slot="connector-up-to-date"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-0 z-[120] flex justify-center pt-[max(0.75rem,var(--openedbot-safe-top))] pr-[max(1rem,var(--openedbot-safe-right))] pl-[max(1rem,var(--openedbot-safe-left))]"
    >
      <Alert
        variant="success"
        icon={CircleCheck}
        title={t("connectorUpgrade.upToDateTitle")}
        className="pointer-events-auto w-full max-w-lg shadow-[var(--shadow-elevated)]"
      >
        <p>{t("connectorUpgrade.upToDate", { version, runtime: runtimeName })}</p>
      </Alert>
    </aside>
  );
}

/**
 * Permanent way back to the latest edge-setup release notes. The update
 * dialog above only opens while an upgrade is pending and not yet seen; once
 * the host is current (or the dialog was closed), the notes stay reachable
 * from the runtime settings through this button.
 */
export function ConnectorReleaseNotesButton() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const release = useQuery({
    queryKey: queryKeys.connectorRelease,
    queryFn: api.connectorRelease,
    staleTime: RELEASE_STALE_MS,
  });
  const latest = release.data?.release ?? null;
  if (!latest?.notes) return null;
  return (
    <>
      <button type="button" className={BUTTON.small} title={t("connectorUpgrade.notesTitle", { version: latest.version })} onClick={() => setOpen(true)}>
        {t("connectorUpgrade.notesButton")}
      </button>
      {open ? (
        <Dialog
          open
          onClose={() => setOpen(false)}
          title={t("connectorUpgrade.notesTitle", { version: latest.version })}
          closeLabel={t("common.close")}
          className="max-w-2xl"
          footer={
            <button type="button" className={BUTTON.primary} onClick={() => setOpen(false)}>{t("common.close")}</button>
          }
        >
          <section data-connector-release-notes="" className="space-y-2 text-sm">
            <div className="scrollbar-subtle max-h-[min(60vh,480px)] overflow-y-auto rounded-lg bg-surface-sunken px-3 py-2 text-muted-foreground">
              <ReleaseNotes body={latest.notes} />
            </div>
            <a href={latest.url} target="_blank" rel="noreferrer" className="inline-block text-sm underline underline-offset-2">
              {t("connectorUpgrade.dialogNotesMore")}
            </a>
          </section>
        </Dialog>
      ) : null}
    </>
  );
}
