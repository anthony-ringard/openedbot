// Preuve d'intégration (vraie base) du fix "approval_policy_mode ne se
// réinitialise que si la VALEUR change" (PR #61, bots.ts). Boucle complète
// demandée en revue :
//   - un bot déjà "prouvé" (mode + effective_at récents) sous un gate PÉRIMÉ
//     (gateIdentity: false) n'est JAMAIS revérifié par la réconciliation,
//     tant que personne ne retouche son permissionMode : la racine du
//     symptôme "demandes d'autorisation répétées malgré des permissions
//     correctes" — hasRecentProof() fait confiance à un drapeau périmé.
//   - un resave EXPLICITE du même permissionMode (updateBotRow, vraie requête
//     SQL contre Postgres) remet la preuve à zéro.
//   - le passage de réconciliation SUIVANT revérifie alors réellement l'hôte,
//     et obtient une preuve neuve sous le protocole de gate actuel.
import { withDisposablePostgres } from "./disposable-postgres";
import { updateBotRow } from "../../modules/roster/src/sql/bots";
import { reconcileHostApprovalPolicies } from "../../apps/worker/src/maintenance/approval-policy-reconciliation";
import { RELAY_FEATURE_APPROVAL_POLICY } from "../../protocol/connector/src/relay-features";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
// Le curseur de pagination de reconcileHostApprovalPolicies est un état de
// MODULE, pensé pour balayer un grand lot sur plusieurs tics : avec un seul
// bot rappelé en boucle serrée, un passage sur deux l'exclut (cursor déjà au
// delà de son id) avant de se réinitialiser. Deux appels couvrent ce cycle.
async function reconcileTwice(...args: Parameters<typeof reconcileHostApprovalPolicies>): Promise<void> {
  await reconcileHostApprovalPolicies(...args);
  await reconcileHostApprovalPolicies(...args);
}
const noopLock = (_organizationId: string, _botId: string, run: () => Promise<unknown>) => run();

const ORG = "91460000-0000-4000-8000-000000000001";
const BOT = "91460000-0000-4000-8000-000000000003";
const id = (n: number) => `91460000-0000-4000-8000-${String(n).padStart(12, "0")}`;

await withDisposablePostgres("openedbot146_reprovision", async ({ owner, connect }) => {
  await owner`insert into organizations (id, slug, name, permission_pipeline) values (${ORG}, 'openedbot146', 'Reprovision', 'v2')`;
  await owner`insert into sections (id, organization_id, name, position) values (${id(4)}, ${ORG}, 'Reprov', 0)`;
  await owner`insert into bots (id, organization_id, section_id, name, slug, position, permission_mode, hermes_profile, hermes_profile_managed)
    values (${BOT}, ${ORG}, ${id(4)}, 'Nexus', 'nexus', 0, 'auto', 'nexus', true)`;
  // Preuve déjà posée, FRAÎCHE (< 10 min), mais sous un gate d'hôte PÉRIMÉ :
  // c'est exactement l'état d'un bot migré d'un ancien protocole de gate.
  await owner`update bots set approval_policy_mode = 'ask_writes', approval_policy_effective_at = now() where id = ${BOT}`;
  const linkHash = new Bun.CryptoHasher("sha256").update(crypto.randomUUID()).digest("hex");
  await owner`insert into runtimes (id, organization_id, name, reachability, is_active, capacity, link_last_seen_at, link_token_hash, link_features)
    values (${id(5)}, ${ORG}, 'Fixture connector', 'connector', true, 8, now(), ${linkHash}, array[${RELAY_FEATURE_APPROVAL_POLICY}]::text[])`;

  const db = await connect("openedbot_worker");
  const hostCalls: string[] = [];
  let hostGateIdentity: boolean = false; // le gate installé côté hôte est l'ANCIEN protocole.
  const clientFactory = (() => ({
    hostProfileInventory: async () => { hostCalls.push("inventory"); return { profiles: [{ name: "nexus" }] }; },
    hostApprovalPolicy: async () => { hostCalls.push("get"); return { mode: "ask_writes", pluginEnabled: true, effective: true, gateIdentity: hostGateIdentity, blockedTools: [] }; },
    hostSetApprovalPolicy: async (_profile: string, mode: string) => {
      hostCalls.push(`put:${mode}`);
      hostGateIdentity = true; // réinstaller la policy installe aussi le bundle de gate actuel.
      return { mode, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] };
    },
  })) as never;

  // --- Avant le fix (comportement observable AVANT tout resave) : la preuve
  // fraîche est prise pour argent comptant, l'hôte n'est jamais recontacté,
  // le gate périmé reste périmé indéfiniment. ---
  await reconcileTwice(db as never, {} as never, undefined, clientFactory, noopLock as never);
  assert(hostCalls.length === 0, `Un bot déjà 'prouvé' récemment ne doit PAS être recontacté sans resave explicite (appels: ${JSON.stringify(hostCalls)}).`);

  // --- Resave explicite du même mode ('auto' -> 'auto') : le vrai SQL d'updateBotRow. ---
  await owner.begin(async (tx) => {
    await updateBotRow(tx as never, ORG, BOT, {
      name: null, description: undefined, instructions: null, model: undefined,
      reasoningEffort: undefined, pinned: null, face: undefined, voiceId: undefined,
      sectionId: null, archived: null, editor: { permissionMode: "auto" }, autonomy: undefined,
    } as never, null);
  });

  const afterResave = await owner<Array<{ approval_policy_mode: string | null; approval_policy_effective_at: Date | null }>>`
    select approval_policy_mode, approval_policy_effective_at from bots where id = ${BOT}`;
  assert(afterResave[0]!.approval_policy_mode === null, "Le resave (même valeur) doit remettre approval_policy_mode à zéro en vraie base.");
  assert(afterResave[0]!.approval_policy_effective_at === null, "Le resave (même valeur) doit remettre approval_policy_effective_at à zéro en vraie base.");

  // --- Le passage de réconciliation SUIVANT doit maintenant revérifier
  // réellement l'hôte, et obtenir une preuve neuve sous le gate actuel. ---
  await reconcileTwice(db as never, {} as never, undefined, clientFactory, noopLock as never);
  assert(hostCalls.length > 0, "Après le resave, la réconciliation DOIT recontacter l'hôte (plus de confiance aveugle à un drapeau périmé).");
  assert(hostCalls.includes(`put:ask_writes`), `L'hôte doit recevoir une réinstallation du gate (appels: ${JSON.stringify(hostCalls)}).`);
  assert(hostGateIdentity === true, "Le gate côté hôte doit être le protocole actuel après réinstallation.");

  const afterReconcile = await owner<Array<{ approval_policy_mode: string | null; approval_policy_effective_at: Date | null }>>`
    select approval_policy_mode, approval_policy_effective_at from bots where id = ${BOT}`;
  assert(afterReconcile[0]!.approval_policy_mode === "ask_writes", "Une preuve neuve doit être écrite après la revérification.");
  assert(afterReconcile[0]!.approval_policy_effective_at !== null, "La preuve neuve doit être marquée effective.");

  // --- Et SEULEMENT maintenant (preuve neuve sous le gate actuel), un
  // troisième passage sans aucun nouveau resave ne recontacte plus l'hôte :
  // la boucle ne spamme pas indéfiniment une fois réellement réparée. ---
  const callsBeforeThird = hostCalls.length;
  await reconcileTwice(db as never, {} as never, undefined, clientFactory, noopLock as never);
  assert(hostCalls.length === callsBeforeThird, "Une fois réparé, un passage sans resave ne doit plus recontacter l'hôte.");

  console.info(JSON.stringify({ event: "openedbot146.approval_reprovision.passed" }));
});
