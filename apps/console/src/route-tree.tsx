import { fleetSection, selectFleetOrganization, WorkspaceDialogScope } from "./components/workspace/workspace-navigation";
import {
  fleetHomeHref,
  fleetInPath,
  internalWorkspacePath,
  isWorkspacePath,
  workspaceHref,
  workspaceInPath,
  workspaceRewriteInput,
  FLEET_ENTRY_PATH,
} from "./lib/workspace/workspace-location";
import {
  accountAvailableWorkspaces,
  findWorkspace,
  rememberAccountWorkspaces,
} from "./lib/workspace/workspace-directory";
import { activeOrganizationId, readCloudSession, saveCloudSession } from "./lib/session/cloud-session";
import {
  isOwnFleet,
  needsOrganization,
  ONBOARDING_PATH,
  ORGANIZATION_SETUP_PATH,
} from "./lib/session/organization-gate";
import type { AccountWorkspacesDto } from "@openedbot/contracts-api";
import { Suspense, useEffect, useRef } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  isRedirect,
  lazyRouteComponent,
  Outlet,
  redirect,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { SkeletonRegion, useIsMobile } from "@openedbot/browser-ui-kit";
import { AppErrorScreen } from "./components/app-error-boundary";
import { clearAppAccessHint, hasAppAccessHint, markAppAccess } from "./lib/session/app-access-hint";
import { NotFoundScreen } from "./components/app-not-found";
import { AppFrameSkeleton } from "./components/skeletons/frame-skeletons";
import { FleetClientLoading } from "./pro-console/slots";
import { proConsole, proFeatureEntitled } from "./pro-console/registry";
import { Shell } from "./components/shell";
import { mobileTransition } from "./lib/shell/mobile-navigation";
import { consumeMobileLanding, firstRosterBotId, isMobileLandingConsumed } from "./lib/shell/mobile-landing";
import { SiteHeader } from "./components/dashboard/site-header";
import { api, queryKeys } from "./lib/api";
import { queryClient } from "./lib/query-client";
import { readSupportDeskAvailable } from "./lib/support/support-desk-availability";
import { resolveLegacyConversation } from "./lib/thread/conversation-href";
import { prefetchConversation, prefetchConversationForPath, restoreConversationForPath } from "./lib/thread/conversation-prefetch";
import { readGlobalSearchFocus } from "./lib/thread/global-search-focus";
import { groupRoutes } from "./group-routes";
import { SHOW_DEV_SETTINGS } from "./lib/shell/dev-settings-ui";
import { needsOnboarding } from "./lib/session/onboarding-gate";
import { needsPasswordChange, PASSWORD_CHANGE_PATH } from "./lib/session/password-change-gate";
import { APP_HOME_HREF, resolveAppFrameEntry, rootRewriteInput, rootRewriteOutput } from "./lib/session/public-landing-gate";
import { ensureAuthStatus, isAppAuthenticated } from "./lib/session/auth-status";
import { subscribeCloudSession } from "./lib/session/cloud-session";
import { useT } from "./lib/i18n";
import { ConversationBodySkeleton } from "./components/thread-skeleton";
import { isPendingBotId } from "./lib/bots/pending-bot-creations";
import { isRuntimeSection, type RuntimeSection } from "./screens/settings/installation/cloud/cloud-shared";
import { SETTINGS_SECTIONS, SettingsBodySkeleton } from "./screens/settings/sections";
import { SupportLauncher } from "./components/support/support-launcher";
import { WebWorkflowNotificationBridge } from "./components/web-workflow-notification-bridge";
import { BrowserTabMetadata } from "./components/browser-tab-metadata";
import { CompactEmpty } from "./components/compact/compact-frame";
import { appUrl, nativeAuth, nativeBridge } from "./lib/platform";
import { COMPACT_PATH, primeNativeSession, readCompactLastBot } from "./lib/shell/compact-shell";
import {
  CloudSessionGate,
  OrganizationFrame,
  requireAppAccess,
  warmAppAccess,
  requireAuth,
  resolveWorkspaceLocation,
} from "./lib/session/route-guards";
import { AppFrame } from "./components/frames/app-frame";
import { CompactFrameEntry } from "./components/frames/compact-frame-entry";
import { SettingsFrame } from "./components/frames/settings-frame";

// Every screen but the frame is its own chunk, loaded when its route matches
// (TanStack `lazyRouteComponent`, preloaded by the router before render), the
// conversation included (ADR 0001, D1b): a refresh evaluates no other screen,
// and the thread list never waits for the composer, the timeline or markdown.
// The agency screens come from its pro console module (`src/pro-console/`):
// solo, there is none, and their routes are not registered (`routeTree`).
const FLEET_SCREENS = proConsole().fleet?.screens;
const ConversationScreen = lazyRouteComponent(() => import("./screens/conversation/conversation"), "ConversationScreen");
const BotCreatingScreen = lazyRouteComponent(() => import("./components/bot-create/bot-creating-screen"), "BotCreatingScreen");
const OrganizationSetupScreen = lazyRouteComponent(() => import("./screens/onboarding/organization"), "OrganizationSetupScreen");
const MobileSettingsScreen = lazyRouteComponent(() => import("./components/mobile/mobile-settings-screen"), "MobileSettingsScreen");
const InboxScreen = lazyRouteComponent(() => import("./screens/conversation/inbox"), "InboxScreen");
const MemberInvitationScreen = lazyRouteComponent(() => import("./screens/auth/member-invitation"), "MemberInvitationScreen");
const LoginScreen = lazyRouteComponent(() => import("./screens/auth/login"), "LoginScreen");
const ChangePasswordScreen = lazyRouteComponent(() => import("./screens/auth/change-password"), "ChangePasswordScreen");
const OnboardingScreen = lazyRouteComponent(() => import("./screens/onboarding"), "OnboardingScreen");
const OverviewScreen = lazyRouteComponent(() => import("./screens/home/overview"), "OverviewScreen");
const ModeLanding = lazyRouteComponent(() => import("./screens/public/landing"), "ModeLanding");
const LegalScreen = lazyRouteComponent(() => import("./screens/public/legal"), "LegalScreen");
const SupportScreen = lazyRouteComponent(() => import("./screens/support/support"), "SupportScreen");
const CloudRuntimeSettings = lazyRouteComponent(() => import("./screens/settings/installation/cloud"), "CloudRuntimeSettings");

const rootRoute = createRootRoute({
  beforeLoad: resolveWorkspaceLocation,
  component: () => (
    <Shell>
      <CloudSessionGate />
      <OrganizationFrame>
        <BrowserTabMetadata />
        <WebWorkflowNotificationBridge />
        <WorkspaceDialogScope><Outlet /></WorkspaceDialogScope>
      </OrganizationFrame>
      <SupportLauncher />
    </Shell>
  ),
});

/**
 * `/onboarding/organization` : uniquement `?create=1` pour créer l'autre type.
 * Un premier compte sans organisation passe par `/onboarding`.
 */
const organizationSetupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ORGANIZATION_SETUP_PATH,
  validateSearch: (search: Record<string, unknown>): { create?: number; kind?: string } => ({
    create: search.create ? 1 : undefined,
    kind: typeof search.kind === "string" ? search.kind : undefined,
  }),
  beforeLoad: async ({ location, search }) => {
    await requireAuth({ location });
    if (search.create) return;
    const account = await api.accountWorkspaces().catch(() => null);
    if (account) {
      rememberAccountWorkspaces(account);
      const workspaces = accountAvailableWorkspaces(account);
      const agency = account.agencyAvailable ? workspaces.find(isOwnFleet) : undefined;
      if (agency) {
        const session = readCloudSession();
        if (session) saveCloudSession({ ...session, organizationId: agency.id });
        throw redirect({ href: fleetHomeHref(agency.id), reloadDocument: true, replace: true });
      }
      if (needsOrganization(workspaces)) throw redirect({ to: ONBOARDING_PATH, replace: true });
      throw redirect({ to: "/", replace: true });
    }
    throw redirect({ to: ONBOARDING_PATH, replace: true });
  },
  component: OrganizationSetupScreen,
});


/**
 * `/login` : hors des routes protégées, et qui renvoie à l'application une
 * fenêtre déjà authentifiée (revenir sur `/login` par un favori ne doit pas
 * montrer un bouton pour ce qui est déjà fait).
 */
const fleetInvitationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/fleet/$token",
  component: FLEET_SCREENS?.FleetInvitationScreen,
});

const memberInvitationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/member/$token",
  component: MemberInvitationScreen,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>): { redirect?: string; reason?: string; email?: string } => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
    reason: typeof search.reason === "string" ? search.reason : undefined,
    email: typeof search.email === "string" ? search.email : undefined,
  }),
  beforeLoad: async ({ search }) => {
    const status = await ensureAuthStatus();
    if (status.kind !== "unknown" && isAppAuthenticated(status)) {
      const { clearPendingAttempt } = await import("./screens/auth/login");
      clearPendingAttempt();
      const target = search.redirect && search.redirect.startsWith("/") ? search.redirect : "/";
      throw redirect({ to: target, replace: true });
    }
    // Coque native : la session vient de ses jetons. Une coque qui sait mener
    // la connexion (`nativeAuth`) reste ici et passe par son pont ; une plus
    // ancienne reprend la main et montre sa page locale. Une API injoignable
    // (`unknown`) n'efface rien : ce n'est pas un refus.
    const bridge = nativeBridge();
    if (bridge && !nativeAuth() && status.kind === "none") await bridge.signOut();
  },
  component: LoginRoute,
});

/**
 * `/change-password` : la PREMIÈRE connexion d'un compte monté par l'équipe.
 *
 * Hors du cadre de l'application et hors de celui des réglages : c'est tout le
 * point. Le garde y envoie quiconque porte encore un mot de passe temporaire
 * (`lib/session/password-change-gate.ts`), et cet écran n'a qu'une chose à faire.
 *
 * Deux renvois, et ils tiennent l'écran honnête : sans session on repart vers
 * `/login`, et un compte qui n'a plus rien à changer repart vers
 * l'application. Sans le second, cette adresse deviendrait un second écran de
 * changement de mot de passe, concurrent de `/settings/security`, atteignable
 * par un favori et sans rien pour dire pourquoi il s'ouvre.
 */
const changePasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/change-password",
  beforeLoad: async ({ location }) => {
    const status = await ensureAuthStatus();
    if (!isAppAuthenticated(status)) {
      throw redirect({
        to: "/login",
        search: { redirect: location.href, reason: status.reason ?? undefined },
        replace: true,
      });
    }
    if (!status.mustChangePassword) throw redirect({ to: "/", replace: true });
  },
  component: ChangePasswordRoute,
});

function ChangePasswordRoute() {
  const navigate = useNavigate();
  // `replace` : le mot de passe temporaire n'existe plus, et le bouton
  // « précédent » ne doit pas ramener sur un écran qui redirigerait aussitôt.
  return <ChangePasswordScreen onDone={() => void navigate({ to: "/", replace: true })} />;
}

const legalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/legal/$slug",
  component: LegalScreen,
});

function LoginRoute() {
  const { reason, email } = useSearch({ from: "/login" });
  return <LoginScreen reason={reason} email={email} />;
}

/**
 * Le cadre des écrans de l'application : barre des conversations + inset.
 *
 * Route sans chemin (`id` seul) : elle n'ajoute rien à l'URL, elle ne fait
 * qu'envelopper ses enfants. `Sidebar` et `SidebarInset` doivent rester frères
 * dans le DOM : les sélecteurs `peer-data-*` de `sidebar.tsx` en dépendent pour
 * décaler l'inset quand la barre se replie.
 *
 * `collapsible="icon"` plutôt que `offcanvas` : repliée, la barre garde un rail
 * de visages, les conversations restent atteignables en un clic au lieu de
 * disparaître : ce qui est tout l'intérêt de la replier.
 */
/** Le dernier chemin du cadre dont les gardes sont passés (voir `beforeLoad`). */
let guardedAppPath: string | null = null;
subscribeCloudSession(() => {
  guardedAppPath = null;
});

/** Show the application chrome only after its access guards have passed. */
function AppAccessPending() {
  const { t } = useT();
  const neutral = guardedAppPath ? <AppFrameSkeleton /> : (
    <SkeletonRegion label={t("common.loading")} className="flex h-full min-h-0 w-full flex-1 items-center justify-center bg-background">
      <span className="text-caption text-muted-foreground">{t("common.loading")}</span>
    </SkeletonRegion>
  );
  // An agency opening one of its clients keeps the agency frame while guards run.
  return <FleetClientLoading path={globalThis.location?.pathname ?? ""} fallback={neutral} />;
}

/**
 * The app frame's access guards: session, temporary password, organization,
 * completed onboarding. Throws the redirect a failing guard asks for; marks
 * this user's access on success.
 */
async function guardAppFrame(location: { href: string; pathname: string }): Promise<void> {
  const status = await ensureAuthStatus();
  const entry = resolveAppFrameEntry(status);
  if (entry.kind === "login") {
    throw redirect({
      to: "/login",
      search: { redirect: location.href, reason: entry.reason ?? undefined },
      replace: true,
    });
  }
  // Le même garde que `requireAuth` : la coque de l'application n'ouvre rien
  // tant qu'un mot de passe temporaire n'a pas été remplacé.
  if (needsPasswordChange(status, location.pathname)) {
    throw redirect({ to: PASSWORD_CHANGE_PATH, replace: true });
  }
  await requireAppAccess();
  markAppAccess(readCloudSession()?.userId);
}

const appFrameRoute = createRoute({
  getParentRoute: () => rootRoute,
  // `_` en tête : la convention TanStack pour une route sans chemin. Elle
  // n'apparaît pas dans l'URL mais bien dans les identifiants de route, d'où le
  // `from: "/_app/bot/$botId"` / `"/_app/cs/$botId"` de l'écran de conversation.
  id: "_app",
  /**
   * Le même garde que `requireAuth`. La page publique n'est plus dans la
   * console : elle vit sur le site public (`lib/session/public-site.ts`).
   */
  beforeLoad: async ({ location, cause }) => {
    // Ouvrir ou fermer la surcouche des réglages ne change que l'état
    // d'historique : même route, même écran. Rejouer les gardes relançait
    // `/api/onboarding` et re-rendait le cadre pendant l'animation. Une
    // session expirée entre-temps reste rattrapée par le 401 (`lib/api.ts`).
    if (cause === "stay" && guardedAppPath === location.pathname) return;
    guardedAppPath = null;
    // Not awaited: the guard reads and the conversation reads start together,
    // instead of the loader waiting for session, organization and onboarding.
    warmAppAccess();
    // The cached conversation first, so the frame never paints it as skeletons.
    await restoreConversationForPath(location.pathname, location.search);
    prefetchConversationForPath(location.pathname, location.search);
    // Guards already passed for this user on this browser: open the frame on
    // the cached roster and threads now, check behind it, and redirect only if
    // a guard fails (`lib/session/app-access-hint.ts`).
    if (hasAppAccessHint(readCloudSession()?.userId)) {
      guardedAppPath = location.pathname;
      void guardAppFrame(location).catch((error: unknown) => {
        guardedAppPath = null;
        clearAppAccessHint();
        if (isRedirect(error)) void router.navigate({ ...error.options, replace: true });
      });
      return;
    }
    await guardAppFrame(location);
    guardedAppPath = location.pathname;
  },
  component: AppFrame,
  // The destination can still be login or onboarding while guards resolve.
  // Keep that wait neutral; paint the app silhouette only after access passes.
  pendingComponent: AppAccessPending,
});


/**
 * L'aperçu : cartes, graphique, table. Il cède la place au parcours d'accueil
 * tant que celui-ci n'a pas été terminé.
 *
 * UN déclencheur, et un seul : `completed === false` (`needsOnboarding`),
 * c'est-à-dire le cloud API qui dit « cette personne n'est pas encore sortie
 * de l'accueil ». Les règles d'avant : registre vide, profil opérateur absent :
 * les déduisaient d'un état qui peut légitimement se reproduire plus tard (on
 * supprime son dernier runtime sans vouloir refaire l'accueil). La sortie est
 * un fait PAR PERSONNE (`users.onboarding_completed`), et les trois chemins
 * qui y mènent (`full`, `runtime_skipped`, `skip_existing`) la posent tous ;
 * `onboardedAt`, la sortie datée de l'espace, reste informatif.
 */
const indexRoute = createRoute({
  getParentRoute: () => appFrameRoute,
  path: "/",
  beforeLoad: async () => {
    if (typeof window === "undefined" || !readCloudSession()) return;
    const arrival = window.location.pathname;
    if (arrival !== APP_HOME_HREF && internalWorkspacePath(arrival) !== "/") return;
    const account = await api.accountWorkspaces().catch(() => null);
    // L'accueil d'une organisation agence est sa flotte, pas un fil de conversation.
    const current = account?.workspaces.find((w) => w.id === activeOrganizationId());
    // Same organization: the output rewrite writes `/o/<agency>/fleet`.
    if (account?.agencyAvailable && current && isOwnFleet(current)) {
      throw redirect({ to: "/fleet", replace: true });
    }
  },
  component: IndexRoute,
  // `beforeLoad` lit les espaces du compte (redirection vers la flotte) : le
  // cadre est déjà là, seul le contenu attend. Son en-tête ne dépend de rien,
  // il est peint tel quel ; aucune forme ne promet la scène en dessous.
  pendingComponent: IndexPending,
});

/** L'en-tête du Salon, le même que celui d'`OverviewScreen`, sans la scène. */
function IndexPending() {
  const { t } = useT();
  const isMobile = useIsMobile();
  return (
    <div className="openedbot-salon-shell relative flex min-h-0 flex-1 flex-col">
      <SiteHeader title={t("overviewPlaceholder.nav")} heading={isMobile} align="center" root />
    </div>
  );
}

function IndexRoute() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const onboarding = useQuery({ queryKey: queryKeys.onboarding, queryFn: api.onboarding });
  // Ni pendant, ni sur erreur : une lecture qui n'a pas abouti (cloud API pas
  // encore prêt) ne prouve rien, et rediriger dessus enverrait refaire un
  // parcours déjà fait à chaque redémarrage lent de l'API cloud. `false`
  // STRICTEMENT, c'est le cloud API qui dit « ce champ existe et cette personne
  // n'est pas encore sortie » ; `undefined` : un cloud API d'avant le flag : ne dit rien.
  const toOnboarding =
    !onboarding.isPending && !onboarding.error && needsOnboarding(onboarding.data);

  // MÊME clé que le panneau : sur téléphone le drawer monte le roster dans la
  // même frame, l'arrivée lit son cache et n'ajoute pas de requête.
  const roster = useQuery({
    queryKey: queryKeys.roster,
    queryFn: api.roster,
    enabled: isMobile && !toOnboarding,
  });
  /**
   * Une app de conversation s'ouvre sur un fil, pas sur un tableau de bord :
   * à l'ARRIVÉE (premier `/` du chargement), un registre non vide sélectionne
   * le premier bot du panneau. Registre vide : ou lecture en échec : et on
   * reste sur l'aperçu, qui porte le « Nouveau bot ».
   *
   * Le loquet est lu une fois au montage : « Aperçu » du menu de l'opérateur
   * doit rester atteignable ensuite, et une bascule en cours de rendu ferait
   * varier ce que ce composant retourne.
   */
  const isArrival = useRef(!isMobileLandingConsumed()).current;
  const autoBotId = isMobile && isArrival && roster.isSuccess ? firstRosterBotId(roster.data.bots) : null;
  const awaitingArrival = isMobile && isArrival && !toOnboarding && (onboarding.isPending || roster.isPending);

  useEffect(() => {
    if (toOnboarding) {
      void navigate({ to: "/onboarding", replace: true });
      return;
    }
    if (!isMobile || !isArrival || awaitingArrival) return;
    // Décidé une fois : un roster qui échoue au lancement laisse sur
    // l'aperçu, il ne prépare pas un saut au prochain succès.
    if (!consumeMobileLanding()) return;
    if (autoBotId) void navigate({ to: "/bot/$botId", params: { botId: autoBotId }, search: {}, replace: true });
  }, [toOnboarding, isMobile, isArrival, awaitingArrival, autoBotId, navigate]);

  if (toOnboarding) return null;
  // Rien plutôt qu'un aperçu qui saute : la scène est déjà sous l'en-tête du
  // drawer, et la redirection tombe dans la foulée.
  if (awaitingArrival || autoBotId) return null;

  // L'en-tête vit dans l'écran : sur téléphone il porte le « + » qui ouvre la
  // même feuille « Nouveau bot » que la scène, et lit le défilement de celle-ci.
  return (
    <div className="openedbot-salon-shell relative flex min-h-0 flex-1 flex-col">
      <OverviewScreen />
    </div>
  );
}

/** Le parcours d'accueil, hors du cadre `appFrameRoute` : pas de barre latérale tant qu'il n'y a rien à y ranger. */
const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  beforeLoad: async ({ location }) => {
    await requireAuth({ location });
  },
  /**
   * `review=1` : l'entrée VOLONTAIRE (« Revoir l'accueil » de la Vue
   * d'ensemble). Sans elle, une personne qui a déjà terminé son accueil est
   * renvoyée vers `/` : le parcours est par personne (`completed`), et une
   * nouvelle connexion ne doit jamais le remontrer.
   */
  validateSearch: (search: Record<string, unknown>): { review?: number } =>
    search.review ? { review: 1 } : {},
  component: OnboardingScreen,
});

/**
 * Ancien `/decisions` : le journal vit désormais dans les réglages.
 * Un favori ou un lien interne ne doit pas 404.
 */
const decisionsLegacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/decisions",
  beforeLoad: () => {
    throw redirect({ to: "/settings/decisions", replace: true });
  },
});

/** La boîte « À traiter ». L'en-tête est rendu par l'écran (filtres). */
const inboxRoute = createRoute({
  getParentRoute: () => appFrameRoute,
  path: "/inbox",
  validateSearch: (search: Record<string, unknown>): { kind?: "approval" | "needs_review" | "needs_you" } => ({
    kind: search.kind === "approval" || search.kind === "needs_review" || search.kind === "needs_you" ? search.kind : undefined,
  }),
  component: InboxScreen,
});

const clientSummaryRoute = createRoute({
  getParentRoute: () => appFrameRoute,
  path: "/summary",
  component: FLEET_SCREENS?.FleetClientSummary,
});

const clientConversationsRoute = createRoute({
  getParentRoute: () => appFrameRoute,
  path: "/conversations",
  component: FLEET_SCREENS?.FleetClientConversations,
});

function conversationSearch(search: Record<string, unknown>): { task?: string; focus?: string } {
  return {
    task: typeof search.task === "string" && search.task.length <= 128 ? search.task : undefined,
    focus: readGlobalSearchFocus(search.focus),
  };
}

function BotLandingRoute() {
  const { t } = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SiteHeader title={t("modeLanding.bot.nav")} heading={false} />
      <ModeLanding />
    </div>
  );
}

/** Accueil du mode Bot : `/bot`. Un bot ouvert vit sous `/bot/:botId`. */
const botLandingRoute = createRoute({
  getParentRoute: () => appFrameRoute,
  path: "/bot",
  component: BotLandingRoute,
});

/**
 * Ancien accueil des sessions extra. Un bot n'a plus qu'un fil : `/cs` renvoie
 * au registre plutôt que de rendre un signet mort.
 */
const chatLandingRedirectRoute = createRoute({
  getParentRoute: () => appFrameRoute,
  path: "/cs",
  beforeLoad: () => { throw redirect({ to: "/bot" }); },
});

/** Forever-chat d'un bot : `/bot/:botId`. L'en-tête est rendu par l'écran. */
const botConversationRoute = createRoute({
  getParentRoute: () => appFrameRoute,
  path: "/bot/$botId",
  validateSearch: conversationSearch,
  loaderDeps: ({ search }) => ({ task: search.task }),
  // Not awaited: the screen's chunk, the roster and the thread start now; the
  // screen renders without waiting and reads the same cache entries.
  loader: ({ params, deps }) => {
    void (isPendingBotId(params.botId) ? BotCreatingScreen : ConversationScreen).preload?.();
    if (!isPendingBotId(params.botId)) prefetchConversation(params.botId, deps.task);
  },
  component: BotConversationEntry,
});

/** Un bot en cours de création (`lib/bots/pending-bot-creations.ts`) n'a pas encore de fil. */
function BotConversationEntry() {
  const { botId } = botConversationRoute.useParams();
  return <Suspense fallback={<ConversationBodySkeleton />}>{isPendingBotId(botId) ? <BotCreatingScreen botId={botId} /> : <ConversationScreen />}</Suspense>;
}

/**
 * Dev server only (`screens/dev/`): `/dev/thread-lab` (thread vs prototype on a
 * scripted stream), `/dev/math` (math + mermaid fixture), `/dev/ui` (toasts and
 * shared UI, light and dark). A build turns `import.meta.env.DEV` into `false`
 * and drops routes and chunks; `=== true` for the reason in `dev-settings-ui.ts`.
 */
const devRoutes = import.meta.env.DEV === true
  ? [
      createRoute({ getParentRoute: () => appFrameRoute, path: "/dev/thread-lab", component: lazyRouteComponent(() => import("./screens/dev/thread-lab"), "ThreadLabScreen") }),
      createRoute({ getParentRoute: () => appFrameRoute, path: "/dev/math", component: lazyRouteComponent(() => import("./screens/dev/math-lab"), "MathLabScreen") }),
      createRoute({ getParentRoute: () => appFrameRoute, path: "/dev/ui", component: lazyRouteComponent(() => import("./screens/dev/ui-lab"), "UiLabScreen") }),
    ]
  : [];

/** Ancienne session extra : `/cs/:botId?task=`. Le bot n'a plus qu'un fil. */
const chatSessionRedirectRoute = createRoute({
  getParentRoute: () => appFrameRoute,
  path: "/cs/$botId",
  validateSearch: conversationSearch,
  // `?task=` survit à la redirection : c'est désormais une branche de variante
  // de message, pas une session, et elle vit sous `/bot/:botId`.
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: "/bot/$botId", params: { botId: params.botId }, search });
  },
});

/**
 * Ancien `/c/:slug`. Résout le slug une fois, puis redirige. Un slug inconnu
 * n'est pas deviné sur `/bot` : on affiche « bot disparu ».
 */
const conversationLegacyRoute = createRoute({
  getParentRoute: () => appFrameRoute,
  path: "/c/$botSlug",
  validateSearch: conversationSearch,
  beforeLoad: async ({ params, search }) => {
    const roster = await api.roster();
    const next = resolveLegacyConversation(params.botSlug, search, roster.bots);
    if (!next) return;
    throw redirect({ ...next, replace: true });
  },
  component: ConversationLegacyGone,
});

function ConversationLegacyGone() {
  const { t } = useT();
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      {t("conversation.botGone")}
    </div>
  );
}

/** Le guichet : `/support` ouvre le fil le plus récent, `/support/:id` celui-là. */
const supportRoute = createRoute({
  getParentRoute: () => appFrameRoute,
  path: "/support/{-$conversationId}",
  // Without a desk (solo, `/api/health` `supportDesk`), `/support` does not
  // exist: back home before the page asks the desk anything.
  beforeLoad: async () => {
    if (!(await readSupportDeskAvailable((options) => queryClient.fetchQuery({ ...options, staleTime: Infinity })))) {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: SupportScreen,
});

/**
 * Le cadre des réglages, avec SA barre : sur le modèle d'opentrack, où les
 * réglages vivent délibérément hors du shell principal.
 *
 * Garder la liste des bots ici ne disait rien de l'endroit où on se trouve et
 * ne laissait aucune place aux rubriques.
 */
const settingsFrameRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: async ({ location }) => {
    await requireAuth({ location });
    await requireAppAccess();
  },
  component: SettingsFrame,
});


/**
 * La Vue d'ensemble est la page d'accueil des réglages : comme dans la console
 * de référence. Registre vide, elle renvoie vers l'ajout d'un runtime : le
 * formulaire d'ajout EST la configuration initiale.
 */
const overviewSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/",
  component: SettingsIndexRoute,
});

function SettingsIndexRoute() {
  const { t } = useT();
  const isMobile = useIsMobile();
  if (isMobile) {
    return (
      <>
        <SiteHeader title={t("mobileShell.settings")} />
        <MobileSettingsScreen />
      </>
    );
  }
  const Overview = SETTINGS_SECTIONS["/settings"];
  return <Overview />;
}

/**
 * The legacy account and organization URLs open this combined surface. The personal
 * profile has its own page so agency team controls stay separate from it.
 */
const accountSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/account",
  component: SETTINGS_SECTIONS["/settings/account"],
});

const profileSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/profile",
  component: SETTINGS_SECTIONS["/settings/profile"],
});

const teamSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/team",
  component: SETTINGS_SECTIONS["/settings/team"],
});

/** The agency's own pages: its clients (mandates, invitations) and its journal. */
const fleetClientsSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/clients",
  component: SETTINGS_SECTIONS["/settings/clients"],
});

const fleetJournalSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/journal",
  component: SETTINGS_SECTIONS["/settings/journal"],
});

const organizationSettingsRedirectRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/organization",
  beforeLoad: () => {
    throw redirect({ to: "/settings/account", replace: true });
  },
});

/**
 * Le runtime Hermes : le registre, et le détail du runtime désigné. La
 * section vit dans l'URL (`?section=status|runtimes`) : un onglet se partage
 * et se recharge. L'ancien `?section=agents` retombe sur `/settings/agents`.
 * L'écran se monte nu dans les tests, sans `RouterProvider`.
 */
const runtimeSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/runtime",
  validateSearch: (search: Record<string, unknown>): { section?: RuntimeSection | "agents" } =>
    search.section === "agents" || isRuntimeSection(search.section) ? { section: search.section } : {},
  beforeLoad: ({ search }) => {
    if (search.section === "agents") throw redirect({ to: "/settings/agents", replace: true });
  },
  component: RuntimeSettingsRoute,
});

function RuntimeSettingsRoute() {
  const { t } = useT();
  const { section } = useSearch({ from: "/settings/runtime" });
  const navigate = useNavigate();
  const runtimeSection = section === "agents" ? undefined : section;
  return (
    <>
      <SiteHeader title={t("settingsSidebar.runtime")} />
      {/* Sans frontière locale, le chargement du module remonte à la racine et blanchit la fenêtre entière. */}
      <Suspense fallback={<SettingsBodySkeleton />}>
        <CloudRuntimeSettings
          section={runtimeSection}
          onSectionChange={(next) => {
            void navigate({ to: "/settings/runtime", search: { section: next }, replace: true });
          }}
        />
      </Suspense>
    </>
  );
}

/**
 * Import des agents Hermes : profils déjà sur l'hôte, ou archive. C'était
 * l'onglet Agents de `/settings/runtime` ; une page, comme Connecteurs.
 */
const agentsSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/agents",
  component: SETTINGS_SECTIONS["/settings/agents"],
});

const modelsSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/models",
  component: SETTINGS_SECTIONS["/settings/models"],
});

const appearanceSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/appearance",
  component: SETTINGS_SECTIONS["/settings/appearance"],
});

/**
 * Les archives : bots archivés et conversations masquées. Une destination de
 * réglages plutôt que deux replis au bas de la barre latérale : ce qu'on range
 * se retrouve là où l'on gère, pas dans la liste de ce qui est vivant.
 */
const archivesSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/archives",
  component: SETTINGS_SECTIONS["/settings/archives"],
});

/** L'ancienne liste des fils du support : le guichet est désormais une page. */
const supportSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/support",
  beforeLoad: () => {
    throw redirect({ to: "/support/{-$conversationId}", params: {}, replace: true });
  },
});

const connectorsSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/connectors",
  component: SETTINGS_SECTIONS["/settings/connectors"],
});

const notificationsSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/notifications",
  component: SETTINGS_SECTIONS["/settings/notifications"],
});

const decisionsSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/decisions",
  component: SETTINGS_SECTIONS["/settings/decisions"],
});

const policiesSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/policies",
  component: SETTINGS_SECTIONS["/settings/policies"],
});

const securitySettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/security",
  component: SETTINGS_SECTIONS["/settings/security"],
});

const billingSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/billing",
  beforeLoad: async () => {
    if (!SHOW_DEV_SETTINGS || !(await proFeatureEntitled("billing"))) throw redirect({ to: "/settings", replace: true });
  },
  component: SETTINGS_SECTIONS["/settings/billing"],
});

const developerSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/developer",
  beforeLoad: () => {
    if (!SHOW_DEV_SETTINGS) throw redirect({ to: "/settings", replace: true });
  },
  component: SETTINGS_SECTIONS["/settings/developer"],
});

/**
 * The fleet a URL should open: an explicitly selected agency must be accessible.
 * The generic entry may choose the first agency. `null` without a matching
 * agency, `undefined` when the API does not answer (the screen says so).
 */
async function fleetHomeTarget(fleetId: string | null | undefined, section?: string | null): Promise<string | null | undefined> {
  const account = await api.accountWorkspaces().catch(() => null);
  if (!account) return undefined;
  rememberAccountWorkspaces(account);
  if (!account.agencyAvailable) return fleetUnavailableTarget(account);
  const agency = selectFleetOrganization(accountAvailableWorkspaces(account), fleetId);
  return agency ? fleetHomeHref(agency.id, section) : null;
}

function fleetUnavailableTarget(account: AccountWorkspacesDto): string {
  const personal = accountAvailableWorkspaces(account).find((workspace) => workspace.kind === "personal" && workspace.role !== "agency");
  const session = readCloudSession();
  if (session) saveCloudSession({ ...session, organizationId: personal?.id ?? null });
  return personal ? workspaceHref(personal.id) : ONBOARDING_PATH;
}

/**
 * `/fleets` is only an entry (`?fleet=`, `?choose=`): it opens
 * `/o/<fleet>/fleet`, and renders the no-fleet state when there is none.
 * A full load, because the fleet is another organization's frame and the output
 * rewrite writes the tab's current one.
 */
const fleetEntryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: FLEET_ENTRY_PATH,
  validateSearch: (search: Record<string, unknown>): { fleet?: string; choose?: string } => ({
    fleet: typeof search.fleet === "string" ? search.fleet : undefined,
    choose: typeof search.choose === "string" ? search.choose : undefined,
  }),
  beforeLoad: async ({ location, search }) => {
    await requireAuth({ location });
    await requireAppAccess();
    const target = await fleetHomeTarget(search.fleet, fleetSection(search.choose)?.[2]);
    if (target) throw redirect({ href: target, reloadDocument: true, replace: true });
  },
  component: FLEET_SCREENS?.FleetScreen,
});

/**
 * `/o/<agency>/fleet`, and `/o/<agency>/fleet/choose/<section>` which asks which
 * client opens that section. An organization that is not one of the account's
 * agencies stays closed rather than selecting another fleet.
 */
async function requireFleetFrame(location: { href: string; pathname: string; publicHref: string }, section?: string) {
  await requireAuth({ location });
  await requireAppAccess();
  if (typeof window === "undefined") return;
  const publicPath = appUrl(location.publicHref).pathname;
  // `/o/<agency>/clients/<client>/fleet` mixes two frames: the fleet belongs to
  // the agency alone. Open that agency's fleet, never the hybrid address.
  const clientFleet = fleetInPath(publicPath);
  if (clientFleet) {
    const fleet = await fleetHomeTarget(clientFleet, fleetSection(section)?.[2]);
    if (fleet !== undefined) throw redirect({ href: fleet ?? FLEET_ENTRY_PATH, reloadDocument: true, replace: true });
    return;
  }
  const key = workspaceInPath(publicPath);
  const current = key ? findWorkspace(key, readCloudSession()?.userId) : null;
  if (current && isOwnFleet(current)) return;
  const target = await fleetHomeTarget(key, fleetSection(section)?.[2]);
  if (target === undefined || target === publicPath || (key && target === null)) return;
  throw redirect({ href: target ?? FLEET_ENTRY_PATH, reloadDocument: true, replace: true });
}

const fleetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/fleet",
  beforeLoad: ({ location }) => {
    const path = new URL(location.publicHref, "http://localhost").pathname;
    const section = /\/fleet\/choose\/([^/]+)\/?$/.exec(path)?.[1];
    return requireFleetFrame(location, section);
  },
  component: FLEET_SCREENS?.FleetScreen,
});

/**
 * `/o/<agency>/fleet/choose/<section>` asked which client opens a section
 * before the client tabs existed. Old links land on the fleet, where every
 * client row opens the client and its tabs pick the section.
 */
const fleetChooseRoute = createRoute({
  getParentRoute: () => fleetRoute,
  path: "choose/$section",
  beforeLoad: () => {
    throw redirect({ to: "/fleet", replace: true });
  },
});

export /**
 * La fenêtre compacte (DEV-139) : `/compact` rouvre le dernier bot,
 * `/compact/:botId` est le fil de ce bot, sans aucun chrome produit. Dans la
 * coque native, l'identité vient du pont (`lib/platform/native-bridge.ts`) et la
 * session cloud est posée depuis `/api/auth/me` ; dans un navigateur, le même
 * garde que les routes protégées (cookie).
 */
const compactFrameRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: COMPACT_PATH,
  beforeLoad: async ({ location }) => {
    const bridge = nativeBridge();
    if (bridge) {
      const token = await bridge.readAccessToken();
      if (!token || !(await primeNativeSession())) return { signedOut: true };
      return { signedOut: false };
    }
    await requireAuth({ location });
    return { signedOut: false };
  },
  component: CompactFrameEntry,
});


const compactIndexRoute = createRoute({
  getParentRoute: () => compactFrameRoute,
  path: "/",
  beforeLoad: async ({ context }) => {
    if (context.signedOut) return;
    const roster = await queryClient.fetchQuery({ queryKey: queryKeys.roster, queryFn: api.roster }).catch(() => null);
    if (!roster) return;
    const remembered = readCompactLastBot();
    const kept = roster.bots.find((bot) => bot.id === remembered && bot.archivedAt === null);
    const botId = kept?.id ?? firstRosterBotId(roster.bots);
    if (botId) throw redirect({ to: "/compact/$botId", params: { botId }, replace: true });
  },
  component: CompactEmpty,
});

const compactBotRoute = createRoute({
  getParentRoute: () => compactFrameRoute,
  path: "/$botId",
  validateSearch: conversationSearch,
  loaderDeps: ({ search }) => ({ task: search.task }),
  loader: ({ params, deps }) => prefetchConversation(params.botId, deps.task),
  component: ConversationScreen,
});

/**
 * A pro route exists only when the build carries its console module: solo,
 * `/fleets`, `/fleet`, the client tabs, `/invite/fleet/$token`, `/settings/clients|journal|billing`
 * are not routes at all (the not-found screen answers), never a screen that
 * calls a pro endpoint.
 */
const WITH_FLEET = FLEET_SCREENS !== undefined;
const WITH_BILLING = proConsole().billing !== undefined;
const proRoutes = <R,>(present: boolean, routes: R[]): R[] => (present ? routes : []);

const routeTree = rootRoute.addChildren([
  ...proRoutes(WITH_FLEET, [fleetEntryRoute]),
  ...proRoutes(WITH_FLEET, [fleetRoute.addChildren([fleetChooseRoute])]),
  loginRoute,
  ...proRoutes(WITH_FLEET, [fleetInvitationRoute]),
  memberInvitationRoute,
  changePasswordRoute,
  legalRoute,
  appFrameRoute.addChildren([
    indexRoute,
    inboxRoute,
    ...proRoutes(WITH_FLEET, [clientSummaryRoute, clientConversationsRoute]),
    botLandingRoute,
    chatLandingRedirectRoute,
    botConversationRoute,
    chatSessionRedirectRoute,
    conversationLegacyRoute,
    ...groupRoutes(appFrameRoute),
    supportRoute,
    ...devRoutes,
  ]),
  decisionsLegacyRoute,
  organizationSetupRoute,
  onboardingRoute,
  compactFrameRoute.addChildren([compactIndexRoute, compactBotRoute]),
  settingsFrameRoute.addChildren([
    overviewSettingsRoute,
    accountSettingsRoute,
    profileSettingsRoute,
    teamSettingsRoute,
    ...proRoutes(WITH_FLEET, [fleetClientsSettingsRoute, fleetJournalSettingsRoute]),
    organizationSettingsRedirectRoute,
    runtimeSettingsRoute,
    agentsSettingsRoute,
    modelsSettingsRoute,
    appearanceSettingsRoute,
    ...(["/updates", "/notch"] as const).map((path) => createRoute({ getParentRoute: () => settingsFrameRoute, path, component: SETTINGS_SECTIONS[`/settings${path}`] })), // app Tauri (l'encoche : sur Mac)
    archivesSettingsRoute,
    supportSettingsRoute,
    connectorsSettingsRoute,
    notificationsSettingsRoute,
    decisionsSettingsRoute,
    policiesSettingsRoute,
    securitySettingsRoute,
    ...proRoutes(WITH_BILLING, [billingSettingsRoute]),
    developerSettingsRoute,
  ]),
]);

/** Le temps de la transition, `data-openedbot-vt` sur <html> choisit push ou pop (`mobile.css`). */
const VIEW_TRANSITION_RESET_MS = 400;

/**
 * La pile mobile anime par l'API View Transitions : et seulement elle : sur
 * bureau, entre deux écrans du drawer, ou sous `prefers-reduced-motion`,
 * `false` laisse le routeur remplacer l'écran sans transition.
 */
/**
 * Le chemin de la barre d'adresse, lu dans l'historique du routeur : un clic
 * met à jour son emplacement tout de suite mais ne pousse l'URL qu'au
 * microtask suivant. Lu dans `window.location`, un lien vers la page publique
 * depuis `/login` voyait encore `/login`, prenait `/` pour l'aperçu interne et
 * retombait sur `/login`.
 */
function currentAddressPath(fallback: string): string {
  return routerInstance?.history.location.pathname ?? globalThis.location?.pathname ?? fallback;
}

let routerInstance: { history: { location: { pathname: string } } } | undefined;

export const router = createRouter({
  routeTree,
  rewrite: {
    input: ({ url }) => rootRewriteInput(url, currentAddressPath(url.pathname)) ?? workspaceRewriteInput({ url }),
    output: ({ url }) => {
      const organizationId = activeOrganizationId();
      const root = rootRewriteOutput(url.pathname, organizationId);
      if (root) {
        const next = new URL(url);
        next.pathname = root;
        return next;
      }
      if (!organizationId || !isWorkspacePath(url.pathname)) return url;
      const next = new URL(url);
      next.pathname = workspaceHref(organizationId, internalWorkspacePath(url.pathname));
      return next;
    },
  },
  // L'équivalent d'`error.tsx` : sans lui, une exception dans un écran laisse
  // une page blanche, indiscernable d'un chargement qui n'aboutit pas.
  defaultErrorComponent: ({ error, reset }) => <AppErrorScreen error={error} reset={reset} />,
  // Le pendant d'`error.tsx` pour ce qui n'existe pas : sans lui, TanStack rend
  // « Not Found » en texte nu, en anglais, sans issue. Une URL périmée est un
  // état ORDINAIRE (favori, notification, lien réécrit), pas une anomalie.
  defaultNotFoundComponent: () => <NotFoundScreen />,
  // TanStack attend 1 s avant de montrer un `pendingComponent`, puis le garde
  // 500 ms : une seconde de page blanche au lancement, puis une silhouette
  // qui s'attarde. 150 ms ne montre rien sur une garde servie par le cache,
  // et 200 ms de tenue suffit à ne pas clignoter.
  defaultPendingMs: 150,
  defaultPendingMinMs: 200,
  defaultViewTransition: {
    types: ({ fromLocation, toLocation }) => {
      if (typeof window === "undefined" || !window.matchMedia("(max-width: 767px)").matches) return false;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
      const direction = mobileTransition(fromLocation?.pathname, toLocation.pathname);
      if (direction === null) return false;
      const root = document.documentElement;
      root.setAttribute("data-openedbot-vt", direction);
      window.setTimeout(() => {
        if (root.getAttribute("data-openedbot-vt") === direction) root.removeAttribute("data-openedbot-vt");
      }, VIEW_TRANSITION_RESET_MS);
      return [`openedbot-${direction}`];
    },
  },
});
routerInstance = router;

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
