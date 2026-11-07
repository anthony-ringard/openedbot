import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { updateBotRow } from "../src/sql/bots";
import type { UpdateBotInput } from "../src/domain/bot-input";

function fakeTx() {
  const statements: string[] = [];
  const tx = ((parts: TemplateStringsArray) => {
    statements.push([...parts].join(" "));
    return Promise.resolve([{ id: "bot-1" }]);
  }) as unknown as SQL;
  return { tx, statements };
}

const BASE_INPUT: UpdateBotInput = {
  name: null, description: undefined, instructions: null, model: undefined,
  reasoningEffort: undefined, pinned: null, face: undefined, voiceId: undefined,
  sectionId: null, archived: null, editor: {}, autonomy: undefined,
} as unknown as UpdateBotInput;

test("resaving the same permissionMode still forces the approval policy to reprovision", async () => {
  const { tx, statements } = fakeTx();
  await updateBotRow(tx as never, "org-1", "bot-1", { ...BASE_INPUT, editor: { permissionMode: "auto" } }, null);
  const update = statements.find((sql) => sql.includes("update bots set")) ?? "";
  // No "<> value then null" comparison left: a resubmitted mode, identical
  // or not, must always clear the cached proof so the host gets re-verified.
  expect(update).not.toContain("permission_mode <>");
  expect(update).toContain("approval_policy_mode = case when");
  expect(update).toContain("then null else approval_policy_mode end");
});

test("an edit that never touches permissionMode leaves the approval proof untouched", async () => {
  const { tx, statements } = fakeTx();
  await updateBotRow(tx as never, "org-1", "bot-1", { ...BASE_INPUT, name: "Nouveau nom" }, null);
  const update = statements.find((sql) => sql.includes("update bots set")) ?? "";
  expect(update).toContain("approval_policy_mode = case when");
});
