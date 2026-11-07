import { insertBotDefaultThread } from "@openedbot/conversation/application/threads";
import { readOrganizationPermissionPipeline } from "@openedbot/identity/application/permission-policy";
import type { TransactionDb } from "@openedbot/platform-db";
import { pgTextArray } from "@openedbot/platform-db/text-array";
import { permissionPipelineOf, type PermissionPipelineId } from "@openedbot/runtimes/domain/runtime-contract";
import { readReviewProven } from "@openedbot/runtimes/application/review-profile";
import type { BotRow } from "../domain/bot-dto";
import { queueBotBlobDeletionsTx } from "./bot-purge";
import { nextSectionRowPosition } from "./sections";
import type { EditorSettings, UpdateBotInput } from "../domain/bot-input";

/** Les bots de l'organisation avec leur activité, tels que les voit un opérateur (`userId`). */
export function readRosterBots(
  tx: TransactionDb,
  organizationId: string,
  userId: string,
  includeHidden: boolean,
): Promise<BotRow[]> {
  return tx<BotRow[]>`
        select b.id, t.id as "threadId", b.name, b.slug, b.description, b.instructions, b.model,
               b.reasoning_effort as "reasoningEffort", b.section_id as "sectionId", b.position,
               b.pinned, b.pin_position as "pinPosition", b.face, b.voice_id as "voiceId", b.label, b.reply_language as "replyLanguage",
               b.notify_on_finish as "notifyOnFinish", b.speech_rate as "speechRate", b.permission_mode as "permissionMode",
               b.hermes_profile as "hermesProfile",
               b.approval_policy_mode as "approvalPolicyMode", b.approval_policy_effective_at as "approvalPolicyEffectiveAt",
               b.hermes_profile_managed as "hermesProfileManaged", (select case when j.status = 'needs_attention' then 'needs_attention' else 'configuring' end
                 from profile_import_items i join profile_import_jobs j on j.id = i.job_id and j.organization_id = i.organization_id
                 where i.organization_id = b.organization_id and i.bot_id = b.id and i.reservation_released_at is null limit 1) as "profileImportStatus",
               (select case when pp.status in ('queued','running') then 'preparing' when pp.status = 'failed' then 'failed' else null end
                  from bot_profile_provisions pp where pp.organization_id = b.organization_id and pp.bot_id = b.id) as "profileProvisionStatus",
               (select pp.progress from bot_profile_provisions pp where pp.organization_id = b.organization_id
                   and pp.bot_id = b.id and pp.status in ('queued','running')) as "profileProvisionProgress",
               (select case
                 -- Everything is deleted and only the late re-read waits (up to
                 -- verify passes x 60 s, see BOT_HOST_CLEANUP_VERIFY_DELAY_SECONDS):
                 -- "verifying", not "in progress"; the screen keeps polling so a
                 -- failed re-read still shows. A failed pass still reads failed.
                 when hc.status = 'queued' and hc.attempts = 0
                      and cardinality(hc.session_ids) = 0 and cardinality(hc.verify_session_ids) > 0 then 'verifying'
                 when hc.status in ('queued','running') then 'pending'
                 when hc.status = 'failed' then 'failed' else null end
                  from bot_host_cleanups hc where hc.organization_id = b.organization_id and hc.bot_id = b.id
                  order by hc.created_at desc limit 1) as "hostCleanupStatus",
               b.archived_at as "archivedAt",
               b.deleted_at as "deletedAt",
               b.autonomy_enabled as "autonomyEnabled", b.autonomy_max_depth as "autonomyMaxDepth",
               b.autonomy_max_steps as "autonomyMaxSteps", b.autonomy_max_handoffs as "autonomyMaxHandoffs",
               b.autonomy_timeout_seconds as "autonomyTimeoutSeconds", b.autonomy_token_budget as "autonomyTokenBudget",
               b.created_at as "createdAt", b.updated_at as "updatedAt",
               exists(
                 select 1 from approval_requests a
                  where a.organization_id = b.organization_id and a.thread_id = t.id and a.status = 'pending'
                    -- A gate under automatic review (PERM2-7) waits on no human.
                    and a.decision_state is distinct from 'reviewing'
               ) as "awaitingApproval",
               exists(
                 select 1 from runs active_run
                  where active_run.organization_id = b.organization_id
                    and active_run.thread_id = t.id
                    -- unknown + ambiguous waits on a human (« À vérifier »), it is not thinking.
                    and active_run.status in ('queued','starting','running','awaiting_approval','relaying','unknown')
                    and not (active_run.status = 'unknown' and active_run.external_state = 'ambiguous')
               ) as running,
               (
                 select left(coalesce(m.content->0->>'text', ''), 160) from messages m
                  where m.organization_id = b.organization_id and m.thread_id = t.id
                  order by m.created_at desc limit 1
               ) as preview,
               greatest(
                 b.updated_at,
                 t.updated_at,
                 coalesce(activity."lastActivityAt", '-infinity'::timestamptz)
               ) as "lastActivityAt",
               coalesce(
                 -- HTTP/JS sérialise à la milliseconde, PostgreSQL garde les
                 -- microsecondes : sans normaliser, .216161 restait à jamais
                 -- « après » le watermark visible .216.
                 date_trunc('milliseconds', activity."lastAttentionAt") > reads.read_at,
                 activity."lastAttentionAt" is not null
               ) as unread,
               (hidden.thread_id is not null) as hidden,
               (
                 select max(r.created_at) from runs r
                  where r.organization_id = b.organization_id and r.thread_id = t.id
               ) as "lastRunAt"
          from bots b
          join threads t on t.organization_id = b.organization_id and t.bot_id = b.id and t.is_default
          left join thread_reads reads
            on reads.organization_id = b.organization_id
           and reads.thread_id = t.id
           and reads.user_id = ${userId}
          left join thread_hides hidden
            on hidden.organization_id = b.organization_id
           and hidden.thread_id = t.id
           and hidden.user_id = ${userId}
          left join lateral (
            select max(item.occurred_at) as "lastActivityAt",
                   max(item.occurred_at) filter (where item.attention) as "lastAttentionAt"
              from (
                select m.created_at as occurred_at,
                       (m.role = 'assistant' or coalesce(m.original_author_bot_id, m.author_bot_id) is not null) as attention
                  from messages m
                 where m.organization_id = b.organization_id and m.thread_id = t.id
                union all
                select event.occurred_at, true
                  from run_events event
                 where event.organization_id = b.organization_id and event.thread_id = t.id
              ) item
          ) activity on true
         where b.organization_id = ${organizationId}
           and (${includeHidden}::boolean or hidden.thread_id is null)
         order by b.pinned desc, "lastActivityAt" desc, b.position asc
  `;
}

/** Un bot relu après écriture : sans activité, le fil par défaut seul. */
export function readBotRows(tx: TransactionDb, organizationId: string, id: string) {
  return tx<BotRow[]>`
    select b.id, t.id as "threadId", b.name, b.slug, b.description, b.instructions, b.model,
           b.reasoning_effort as "reasoningEffort", b.section_id as "sectionId", b.position,
           b.pinned, b.pin_position as "pinPosition", b.face, b.voice_id as "voiceId", b.label, b.reply_language as "replyLanguage",
               b.notify_on_finish as "notifyOnFinish", b.speech_rate as "speechRate", b.permission_mode as "permissionMode",
               b.hermes_profile as "hermesProfile",
           b.approval_policy_mode as "approvalPolicyMode", b.approval_policy_effective_at as "approvalPolicyEffectiveAt",
           b.hermes_profile_managed as "hermesProfileManaged", (select case when j.status = 'needs_attention' then 'needs_attention' else 'configuring' end
                 from profile_import_items i join profile_import_jobs j on j.id = i.job_id and j.organization_id = i.organization_id
                 where i.organization_id = b.organization_id and i.bot_id = b.id and i.reservation_released_at is null limit 1) as "profileImportStatus",
           (select case when pp.status in ('queued','running') then 'preparing' when pp.status = 'failed' then 'failed' else null end
              from bot_profile_provisions pp where pp.organization_id = b.organization_id and pp.bot_id = b.id) as "profileProvisionStatus",
           (select pp.progress from bot_profile_provisions pp where pp.organization_id = b.organization_id
               and pp.bot_id = b.id and pp.status in ('queued','running')) as "profileProvisionProgress",
           (select case
                 -- Everything is deleted and only the late re-read waits (up to
                 -- verify passes x 60 s, see BOT_HOST_CLEANUP_VERIFY_DELAY_SECONDS):
                 -- "verifying", not "in progress"; the screen keeps polling so a
                 -- failed re-read still shows. A failed pass still reads failed.
                 when hc.status = 'queued' and hc.attempts = 0
                      and cardinality(hc.session_ids) = 0 and cardinality(hc.verify_session_ids) > 0 then 'verifying'
                 when hc.status in ('queued','running') then 'pending'
                 when hc.status = 'failed' then 'failed' else null end
              from bot_host_cleanups hc where hc.organization_id = b.organization_id and hc.bot_id = b.id
              order by hc.created_at desc limit 1) as "hostCleanupStatus",
           b.archived_at as "archivedAt",
               b.deleted_at as "deletedAt",
           b.autonomy_enabled as "autonomyEnabled", b.autonomy_max_depth as "autonomyMaxDepth",
           b.autonomy_max_steps as "autonomyMaxSteps", b.autonomy_max_handoffs as "autonomyMaxHandoffs",
           b.autonomy_timeout_seconds as "autonomyTimeoutSeconds", b.autonomy_token_budget as "autonomyTokenBudget",
           b.created_at as "createdAt", b.updated_at as "updatedAt", false as "awaitingApproval",
           false as hidden,
           null::text as preview, greatest(b.updated_at, t.updated_at) as "lastActivityAt",
           null::timestamptz as "lastRunAt"
      from bots b join threads t on t.organization_id = b.organization_id and t.bot_id = b.id and t.is_default
     where b.organization_id = ${organizationId} and b.id = ${id}
  `;
}

export async function nextBotPosition(
  tx: TransactionDb,
  organizationId: string,
  sectionId: string,
): Promise<number> {
  return nextSectionRowPosition(tx, organizationId, sectionId);
}

/** Le prochain rang dans la section visée par un déplacement : le bot déplacé ne compte pas. */
export async function nextBotPositionExcluding(
  tx: TransactionDb,
  organizationId: string,
  sectionId: string,
  botId: string,
): Promise<number> {
  return nextSectionRowPosition(tx, organizationId, sectionId, { kind: "bot", id: botId });
}

/** Le bot et son fil par défaut, dans la même transaction. */
export async function insertBotWithThread(
  tx: TransactionDb,
  input: {
    id: string;
    threadId: string;
    organizationId: string;
    sectionId: string;
    name: string;
    slug: string;
    description: string | null;
    instructions: string;
    model: string | null;
    reasoningEffort: string | null;
    hermesProfile: string | null;
    hermesProfileManaged: boolean;
    position: number;
    face: unknown;
    voiceId: string | null;
    autonomy: {
      enabled: boolean;
      maxDepth: number;
      maxSteps: number;
      maxHandoffs: number;
      timeoutSeconds: number;
      tokenBudget: number;
    };
    /** Absent fields keep the column defaults of 0099 (`manual`, `auto`, notify on). */
    editor?: EditorSettings;
    creationRequestId?: string | null;
    /** SHA-256 hex of the request the id was minted for (0136). */
    creationRequestDigest?: string | null;
  },
): Promise<void> {
  const editor = input.editor ?? {};
  await tx`
    insert into bots (
      id, organization_id, section_id, name, slug, description, instructions, model,
      reasoning_effort, hermes_profile, hermes_profile_managed, position, face, voice_id, autonomy_enabled, autonomy_max_depth,
      autonomy_max_steps, autonomy_max_handoffs, autonomy_timeout_seconds, autonomy_token_budget,
      label, reply_language, notify_on_finish, speech_rate, permission_mode, creation_request_id,
      creation_request_digest
    ) values (
      ${input.id}, ${input.organizationId}, ${input.sectionId}, ${input.name}, ${input.slug},
      ${input.description || null},
      ${input.instructions}, ${input.model},
      ${input.reasoningEffort},
      ${input.hermesProfile}, ${input.hermesProfileManaged}, ${input.position},
      ${input.face}, ${input.voiceId}, ${input.autonomy.enabled}, ${input.autonomy.maxDepth},
      ${input.autonomy.maxSteps}, ${input.autonomy.maxHandoffs}, ${input.autonomy.timeoutSeconds}, ${input.autonomy.tokenBudget},
      ${editor.label ?? null},
      coalesce(${editor.replyLanguage ?? null}, 'auto'),
      coalesce(${editor.notifyOnFinish ?? null}, true),
      coalesce(${editor.speechRate ?? null}, 1),
      coalesce(${editor.permissionMode ?? null}, 'manual'),
      ${input.creationRequestId ?? null},
      ${input.creationRequestDigest ?? null}
    )
  `;
  await insertBotDefaultThread(tx, {
    threadId: input.threadId,
    organizationId: input.organizationId,
    botId: input.id,
    title: input.name,
  });
}

/** Ce que la restauration d'un bot exige de savoir : son nom et son profil hôte. */
/**
 * The bot a creation attempt already produced (0135), soft-deleted included:
 * the caller tells a replay from a request whose bot was deleted since.
 */
export async function readBotCreationReplay(
  tx: TransactionDb,
  organizationId: string,
  creationRequestId: string,
): Promise<{ botId: string; deleted: boolean; digest: string | null } | null> {
  const rows = await tx<Array<{ botId: string; deletedAt: Date | null; digest: string | null }>>`
    select b.id as "botId", b.deleted_at as "deletedAt", b.creation_request_digest as "digest"
      from bots b
     where b.organization_id = ${organizationId}
       and b.creation_request_id = ${creationRequestId}
  `;
  const row = rows[0];
  return row ? { botId: row.botId, deleted: row.deletedAt !== null, digest: row.digest ?? null } : null;
}

export async function readBotRestoreTarget(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
): Promise<{ name: string; hermesProfile: string | null; hermesProfileManaged: boolean; permissionMode: BotRow["permissionMode"] } | null> {
  const bots = await tx<Array<{
    name: string;
    hermesProfile: string | null;
    hermesProfileManaged: boolean;
    permissionMode: BotRow["permissionMode"];
  }>>`
    select name, hermes_profile as "hermesProfile", hermes_profile_managed as "hermesProfileManaged", permission_mode as "permissionMode"
      from bots
     where organization_id = ${organizationId} and id = ${botId}
  `;
  return bots[0] ?? null;
}

/** `false` si le bot a disparu entre le verrou et l'écriture. */
export async function updateBotRow(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
  input: UpdateBotInput,
  nextPosition: number | null,
): Promise<boolean> {
  const { autonomy, editor, voiceId } = input;
  const updated = await tx<Array<{ id: string }>>`
    update bots set
      name = coalesce(${input.name}, name),
      description = case when ${input.description !== undefined} then ${input.description ?? null} else description end,
      instructions = coalesce(${input.instructions}, instructions),
      model = case when ${input.model !== undefined} then ${input.model ?? null} else model end,
      reasoning_effort = case when ${input.reasoningEffort !== undefined} then ${input.reasoningEffort ?? null} else reasoning_effort end,
      pinned = coalesce(${input.pinned}, pinned), pin_position = case when ${input.pinned ?? null}::boolean is false then null else pin_position end,
      face = case when ${input.face !== undefined} then ${input.face ?? null} else face end,
      voice_id = case when ${voiceId !== undefined} then ${voiceId ?? null} else voice_id end,
      label = case when ${editor.label !== undefined} then ${editor.label ?? null} else label end,
      reply_language = coalesce(${editor.replyLanguage ?? null}, reply_language),
      notify_on_finish = coalesce(${editor.notifyOnFinish ?? null}, notify_on_finish),
      speech_rate = coalesce(${editor.speechRate ?? null}, speech_rate),
      permission_mode = coalesce(${editor.permissionMode ?? null}, permission_mode),
      -- Saisie explicite de permissionMode (même valeur qu'avant comprise) =
      -- la preuve d'approbation repart à zéro, pour que reconcileHostApprovalPolicies
      -- revérifie l'état réel côté hôte au prochain passage au lieu de faire
      -- confiance à un approval_policy_effective_at récent mais obtenu sous
      -- un ancien protocole de gate (ex. ohb-gate/v1) qu'il ne sait plus lire.
      -- Un simple resave du même mode ne changeait jamais rien avant ce fix.
      approval_policy_mode = case when ${editor.permissionMode !== undefined} then null else approval_policy_mode end,
      approval_policy_effective_at = case when ${editor.permissionMode !== undefined} then null else approval_policy_effective_at end,
      autonomy_enabled = coalesce(${autonomy?.enabled ?? null}, autonomy_enabled),
      autonomy_max_depth = coalesce(${autonomy?.maxDepth ?? null}, autonomy_max_depth),
      autonomy_max_steps = coalesce(${autonomy?.maxSteps ?? null}, autonomy_max_steps),
      autonomy_max_handoffs = coalesce(${autonomy?.maxHandoffs ?? null}, autonomy_max_handoffs),
      autonomy_timeout_seconds = coalesce(${autonomy?.timeoutSeconds ?? null}, autonomy_timeout_seconds),
      autonomy_token_budget = coalesce(${autonomy?.tokenBudget ?? null}, autonomy_token_budget),
      section_id = coalesce(${input.sectionId}, section_id),
      position = coalesce(${nextPosition}, position),
      archived_at = case when ${input.archived !== null}
        then (case when ${input.archived === true} then coalesce(archived_at, now()) else null end)
        else archived_at end,
      -- Restaurer, c'est aussi sortir de la corbeille : sans ce vidage,
      -- archived = false violerait bots_deleted_implies_archived (0031)
      -- et l'operateur ne pourrait plus jamais rendre un bot supprime.
      deleted_at = case when ${input.archived === false} then null else deleted_at end,
      updated_at = now()
    where organization_id = ${organizationId} and id = ${botId}
    returning id
  `;
  return Boolean(updated[0]);
}

/**
 * The organization's permission pipeline (PERM2-1): the host plugin mode a
 * bot needs depends on it (`approvalPolicyMode`).
 */
export async function readPermissionPipeline(tx: TransactionDb, organizationId: string): Promise<PermissionPipelineId> {
  return permissionPipelineOf(await readOrganizationPermissionPipeline(tx, organizationId));
}

/**
 * D-1 (iso Grok Bot): a bot created without an explicit mode starts in
 * `auto` when the organization is on `v2` and its runtime's review profile
 * is proven (PERM2-7a); otherwise `manual`. A copy keeps its source's mode.
 */
export async function defaultPermissionMode(tx: TransactionDb, organizationId: string): Promise<"auto" | "manual"> {
  if (await readPermissionPipeline(tx, organizationId) !== "v2") return "manual";
  if (!(await readReviewProven(tx, organizationId))) return "manual";
  // PERM2-8: the default never goes above the organization's ceiling.
  const ceiling = await tx<Array<{ maxMode: string | null }>>`
    select max_mode as "maxMode" from organization_permission_policies where organization_id = ${organizationId}
  `;
  return ceiling[0]?.maxMode === "manual" ? "manual" : "auto";
}

export async function writeBotApprovalPolicyProof(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
  mode: "ask_writes" | "block_writes" | "off" | null,
  effective: boolean,
): Promise<void> {
  await tx`
    update bots
       set approval_policy_mode = ${mode},
           approval_policy_effective_at = case when ${mode !== null && effective} then now() else null end
     where organization_id = ${organizationId} and id = ${botId}
  `;
}

/** Le profil Hermes d'un bot : seule colonne dont les routes de capacités ont besoin. */
export async function readBotCapabilityTarget(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
): Promise<{ profile: string | null } | null> {
  const rows = await tx<Array<{ profile: string | null }>>`
    select hermes_profile as "profile" from bots
     where organization_id = ${organizationId} and id = ${botId}
  `;
  return rows[0] ?? null;
}

/** Même lecture, sous l'alias du panneau de capacités. */
export async function readBotHermesProfile(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
): Promise<{ hermesProfile: string | null } | null> {
  const bots = await tx<Array<{ hermesProfile: string | null }>>`
    select hermes_profile as "hermesProfile" from bots
     where organization_id = ${organizationId} and id = ${botId}
  `;
  return bots[0] ?? null;
}

/** Ce qu'il faut pour (re)créer le profil hôte d'un bot qui n'est pas supprimé. */
export async function readProfileRepairTarget(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
): Promise<{ name: string; profile: string | null; model: string | null; permissionMode: BotRow["permissionMode"] } | null> {
  const rows = await tx<Array<{ name: string; profile: string | null; model: string | null; permissionMode: BotRow["permissionMode"] }>>`
    select name, hermes_profile as "profile", model, permission_mode as "permissionMode" from bots
     where organization_id = ${organizationId} and id = ${botId} and deleted_at is null
  `;
  return rows[0] ?? null;
}

/** Verrouille le bot avant de lui donner un profil géré. */
export async function lockBotForProfile(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
): Promise<{ id: string; name: string; slug: string; profile: string | null; model: string | null; permissionMode: BotRow["permissionMode"] } | null> {
  const rows = await tx<Array<{
    id: string;
    name: string;
    slug: string;
    profile: string | null;
    model: string | null;
    permissionMode: BotRow["permissionMode"];
  }>>`
    select id, name, slug, hermes_profile as "profile", model, permission_mode as "permissionMode"
      from bots
     where organization_id = ${organizationId} and id = ${botId}
     for update
  `;
  return rows[0] ?? null;
}

/** Pose le profil géré d'un bot qui n'en avait pas ; `false` si un autre appel l'a posé entre-temps. */
export async function setManagedProfile(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
  slug: string,
): Promise<boolean> {
  const updated = await tx<Array<{ id: string }>>`
    update bots set hermes_profile = ${slug}, hermes_profile_managed = true, updated_at = now()
     where organization_id = ${organizationId} and id = ${botId} and hermes_profile is null returning id
  `;
  return Boolean(updated[0]);
}

/**
 * Marks the recreated profile as managed. `model`: `undefined` keeps the
 * bot's own model (transfer), `null` forgets it (reset), a string sets the
 * model picked during the repair.
 */
export async function markProfileRecreated(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
  profile: string,
  model: string | null | undefined,
): Promise<boolean> {
  const updated = await tx<Array<{ id: string }>>`
    update bots set hermes_profile_managed = true,
           model = case when ${model === undefined}::boolean then model else ${model ?? null}::text end,
           -- Un profil recréé repart du clone du profil default : le socle de
           -- capacités doit y être réappliqué.
           capability_baseline_version = 0,
           updated_at = now()
     where organization_id = ${organizationId} and id = ${botId}
       and hermes_profile = ${profile} returning id
  `;
  return Boolean(updated[0]);
}

export type ActiveBotRun = { id: string; stepKind: string | null; threadId: string };

export function lockActiveBotRuns(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
): Promise<ActiveBotRun[]> {
  return tx<ActiveBotRun[]>`
    select r.id, r.step_kind as "stepKind", r.thread_id as "threadId" from runs r
    join threads t on t.organization_id = r.organization_id and t.id = r.thread_id
     where r.organization_id = ${organizationId}
       and (r.bot_id = ${botId} or r.caller_bot_id = ${botId}
         or r.handoff_target_bot_id = ${botId} or t.bot_id = ${botId}
         or (t.group_id is not null and exists (
           select 1 from group_members member where member.organization_id = r.organization_id
             and member.group_id = t.group_id and member.bot_id = ${botId}
         )))
       and r.status in ('queued','starting','running','awaiting_approval','relaying','unknown')
     order by r.id for update of r
  `;
}

/** Ferme la fenêtre entre la première lecture et l'acquisition du verrou FK parent. */
export function readActiveBotRuns(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
): Promise<ActiveBotRun[]> {
  return tx<ActiveBotRun[]>`
    select r.id, r.step_kind as "stepKind", r.thread_id as "threadId" from runs r
    join threads t on t.organization_id = r.organization_id and t.id = r.thread_id
     where r.organization_id = ${organizationId}
       and (r.bot_id = ${botId} or r.caller_bot_id = ${botId}
         or r.handoff_target_bot_id = ${botId} or t.bot_id = ${botId}
         or (t.group_id is not null and exists (
           select 1 from group_members member where member.organization_id = r.organization_id
             and member.group_id = t.group_id and member.bot_id = ${botId}
         )))
       and r.status in ('queued','starting','running','awaiting_approval','relaying','unknown')
       and (r.step_kind is null or r.step_kind not in ('memory', 'compaction'))
     order by r.id limit 1
  `;
}

/** Verrouille la ligne du bot ; `false` s'il n'existe pas. */
export async function lockBotRow(tx: TransactionDb, organizationId: string, botId: string): Promise<boolean> {
  const bots = await tx<Array<{ id: string }>>`
    select id from bots where organization_id = ${organizationId} and id = ${botId}
     for update
  `;
  return Boolean(bots[0]);
}

/** Le bot appartient-il encore à un salon ? Un membre ne peut pas disparaître sous un salon. */
export async function isBotInGroup(tx: TransactionDb, organizationId: string, botId: string): Promise<boolean> {
  const memberships = await tx<Array<{ groupId: string }>>`
    select membership.group_id as "groupId"
      from group_members membership
     where membership.organization_id = ${organizationId} and membership.bot_id = ${botId}
     order by membership.group_id limit 1
  `;
  return Boolean(memberships[0]);
}

/** Un message idempotent encore réservé ou en quarantaine sur un fil du bot. */
export async function hasPendingBotIngress(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
): Promise<boolean> {
  const ingress = await tx<Array<{ id: string }>>`
    select ingress.id from message_ingress ingress
    join threads thread on thread.organization_id = ingress.organization_id and thread.id = ingress.thread_id
     where ingress.organization_id = ${organizationId} and thread.bot_id = ${botId}
       and ingress.state in ('reserved','abandoned')
     limit 1 for update of ingress
  `;
  return Boolean(ingress[0]);
}

export type BotDeletionScope = {
  deletedAt: Date | null;
  profile: string | null;
  profileManaged: boolean;
  threads: Array<{ sessionId: string; threadId: string; sessionGeneration: number }>;
  workflows: Array<{ workflowId: string }>;
};

/**
 * Le profil du bot et tout ce qui nomme une de ses sessions sur le runtime.
 * Un workflow autonome ouvre une session par (workflow, bot) que rien dans
 * `threads` ne nomme : elle se retrouve par les runs du bot.
 */
export async function readBotDeletionScope(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
): Promise<BotDeletionScope | null> {
  const bots = await tx<Array<{ deletedAt: Date | null; profile: string | null; profileManaged: boolean }>>`
    select deleted_at as "deletedAt", hermes_profile as "profile", hermes_profile_managed as "profileManaged" from bots
     where organization_id = ${organizationId} and id = ${botId}
  `;
  if (!bots[0]) return null;
  const threads = await tx<Array<{ sessionId: string; threadId: string; sessionGeneration: number }>>`
    select hermes_session_id as "sessionId", id as "threadId", hermes_session_generation as "sessionGeneration" from threads
     where organization_id = ${organizationId} and bot_id = ${botId}
  `;
  const workflows = await tx<Array<{ workflowId: string }>>`
    select distinct workflow_id as "workflowId" from runs
     where organization_id = ${organizationId} and workflow_id is not null
       and (bot_id = ${botId} or caller_bot_id = ${botId} or handoff_target_bot_id = ${botId})
  `;
  return { deletedAt: bots[0].deletedAt, profile: bots[0].profile, profileManaged: bots[0].profileManaged, threads, workflows };
}

/** Soft delete : la corbeille (`deleted_at`) est toujours archivée aussi (invariant 0031). `false` si le bot n'existe pas. */
export async function softDeleteBot(tx: TransactionDb, organizationId: string, botId: string): Promise<Date | null> {
  const updated = await tx<Array<{ deletedAt: Date }>>`
    update bots
       set archived_at = coalesce(archived_at, now()),
           deleted_at = coalesce(deleted_at, now()),
           updated_at = now()
     where organization_id = ${organizationId} and id = ${botId}
    returning deleted_at as "deletedAt"
  `;
  return updated[0]?.deletedAt ?? null;
}

/** Suppression définitive ; `true` si le bot existait. */
export async function deleteBotRow(tx: TransactionDb, organizationId: string, botId: string): Promise<boolean> {
  await queueBotBlobDeletionsTx(tx, organizationId, botId);
  const gone = await tx<Array<{ id: string }>>`
    delete from bots where organization_id = ${organizationId} and id = ${botId}
    returning id
  `;
  return Boolean(gone[0]);
}

export type ClearedBotModel = { botId: string; profile: string | null; profileManaged: boolean; profileReady: boolean };

/**
 * Remet au modèle global, en UNE requête, chaque bot actif qui porte un modèle
 * ou un effort propre. `profileReady` : aucune provision, ou une provision
 * aboutie ; un profil encore en création n'a rien à aligner.
 */
export function clearBotModelOverrides(tx: TransactionDb, organizationId: string): Promise<ClearedBotModel[]> {
  return tx<ClearedBotModel[]>`
    update bots b
       set model = null, reasoning_effort = null, updated_at = now()
     where b.organization_id = ${organizationId}
       and b.archived_at is null and b.deleted_at is null
       and (b.model is not null or b.reasoning_effort is not null)
    returning b.id as "botId", b.hermes_profile as "profile", b.hermes_profile_managed as "profileManaged",
              coalesce((select p.status from bot_profile_provisions p
                         where p.organization_id = b.organization_id and p.bot_id = b.id), 'succeeded') = 'succeeded' as "profileReady"
  `;
}

/**
 * Parmi `botIds`, ceux qui suivent encore le modèle du runtime : ni supprimés,
 * et sans modèle propre, sauf en mode `global` où le modèle propre dort.
 */
export async function botsFollowingRuntimeModel(tx: TransactionDb, organizationId: string, botIds: string[]): Promise<string[]> {
  if (botIds.length === 0) return [];
  const rows = await tx<Array<{ id: string }>>`
    select b.id from bots b
      join organizations o on o.id = b.organization_id
     where b.organization_id = ${organizationId} and b.id = any(${pgTextArray(botIds)}::text[]::uuid[])
       and b.deleted_at is null
       and (o.model_assignment_mode = 'global' or b.model is null)
  `;
  return rows.map((row) => row.id);
}
