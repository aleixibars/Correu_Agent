"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  TRIAGE_CATEGORIES,
  isAutoDiscardEligible,
  isAutoReplyEligible,
  type TriageCategory,
} from "@correu-agent/shared";
import { setAutoReplyRule } from "@correu-agent/shared/auto-reply";
import { parsePatternList, setAutoDiscardRule } from "@correu-agent/shared/auto-discard";
import { auth } from "../../auth";
import { AUTO_REPLY_PATH, LOGIN_PATH } from "../../lib/routes";
import { db } from "../../lib/db";

/**
 * The category a submission names, once it is one auto-reply may be switched on
 * for. A form field is arbitrary text, so it is matched against the taxonomy
 * rather than cast to it; the form only renders the eligible categories, so
 * anything else is a hand-crafted POST and is refused at the boundary. The rule
 * writer refuses an ineligible category too (`AutoReplyCategoryError`) — this
 * keeps the refusal here, where the untrusted value entered.
 */
const eligibleCategory = (value: FormDataEntryValue | null): TriageCategory => {
  const category = TRIAGE_CATEGORIES.find((known) => known === value);
  if (category === undefined || !isAutoReplyEligible(category)) {
    throw new Error(
      `Auto-reply cannot be configured for the "${String(value)}" category (context.md §4).`,
    );
  }
  return category;
};

/**
 * Saves one category's auto-reply switch and its guidance. The tenant and the
 * actor come from the session, never from the form: the audit entry the rule
 * writer records is only worth anything if it names who really submitted it.
 */
export const saveAutoReplyRule = async (formData: FormData): Promise<void> => {
  const session = await auth();
  if (!session) redirect(LOGIN_PATH);

  const category = eligibleCategory(formData.get("category"));
  const instructions = formData.get("instructions");

  await setAutoReplyRule(db, {
    tenantId: session.user.tenantId,
    category,
    // An unchecked checkbox is not submitted at all, so an absent field is off.
    enabled: formData.get("enabled") === "on",
    instructions: typeof instructions === "string" ? instructions : null,
    actor: { type: "user", userId: session.user.id },
  });

  revalidatePath(AUTO_REPLY_PATH);
};

/**
 * The category a submission names, once it is one auto-discard may be switched
 * on for. Same reasoning as `eligibleCategory` above: the form only renders the
 * eligible categories, so anything else is a hand-crafted POST.
 */
const eligibleDiscardCategory = (
  value: FormDataEntryValue | null,
): TriageCategory => {
  const category = TRIAGE_CATEGORIES.find((known) => known === value);
  if (category === undefined || !isAutoDiscardEligible(category)) {
    throw new Error(
      `Auto-discard cannot be configured for the "${String(value)}" category (context.md §4).`,
    );
  }
  return category;
};

const patternsField = (value: FormDataEntryValue | null): string[] =>
  parsePatternList(typeof value === "string" ? value : null);

/**
 * Saves one category's auto-discard switch and its sender/keyword patterns.
 * The tenant and the actor come from the session, never from the form — same
 * reasoning as `saveAutoReplyRule`.
 */
export const saveAutoDiscardRule = async (formData: FormData): Promise<void> => {
  const session = await auth();
  if (!session) redirect(LOGIN_PATH);

  const category = eligibleDiscardCategory(formData.get("category"));

  await setAutoDiscardRule(db, {
    tenantId: session.user.tenantId,
    category,
    // An unchecked checkbox is not submitted at all, so an absent field is off.
    enabled: formData.get("enabled") === "on",
    senderPatterns: patternsField(formData.get("senderPatterns")),
    keywordPatterns: patternsField(formData.get("keywordPatterns")),
    actor: { type: "user", userId: session.user.id },
  });

  // Both rule kinds live on the same screen (/auto-resposta), so one save
  // refreshes what both sections show.
  revalidatePath(AUTO_REPLY_PATH);
};
