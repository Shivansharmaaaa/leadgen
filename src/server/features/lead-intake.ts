import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { db, contacts, events, leads, messages, tenants } from "@/server/db";
import { handleInbound } from "@/server/core/ingest";
import { resolveContact } from "@/server/core/identity";
import { normalizeEmail, normalizePhone } from "@/server/core/phone";
import { contactData, publish } from "./webhooks";

/**
 * FEATURE 7 — lead intake with an instant first response.
 *
 * Web forms, Google Local Services, Angi, Thumbtack, Facebook lead ads: the
 * leads a local business PAYS for arrive as form submissions, and most of them
 * wait hours for a reply. Contacted within five minutes they are ~21x likelier
 * to qualify, and most customers buy from whoever answers first. So every
 * submission becomes a conversation the agent answers in seconds.
 *
 * The legal shape is what makes this different from the inbound channels. A
 * caller or a DM has contacted us on that channel; a form lead has not. The
 * first text is the BUSINESS initiating contact, which in the US needs prior
 * express written consent: a signed (checkbox counts) agreement that names the
 * seller, covers automated texts, and says consent is not a condition of
 * purchase. Without it the agent still drafts the reply — held in the inbox
 * for a person to call or approve — and nothing is sent.
 *
 * The consent wording is checked, not just the checkbox. A form whose
 * disclosure never names the business is the most common way this goes wrong,
 * and it is invisible until a demand letter arrives. Each problem is recorded
 * so the dashboard can tell the owner exactly what to fix on their site.
 */

export const LEAD_SOURCES = [
  "website", "google_lsa", "angi", "thumbtack", "facebook_lead_ad", "zapier", "other",
] as const;

export const LeadIntakeSchema = z.object({
  source: z.enum(LEAD_SOURCES).default("website"),
  /** The source's own id for this lead — makes redelivery safe. */
  externalId: z.string().min(1).max(200).optional(),
  name: z.string().trim().max(120).optional(),
  phone: z.string().max(40).optional(),
  email: z.string().max(200).optional(),
  service: z.string().trim().max(120).optional(),
  message: z.string().trim().max(4000).optional(),
  postalCode: z.string().trim().max(20).optional(),
  /** When the person submitted it; the speed-to-lead clock starts here. */
  submittedAt: z.string().datetime({ offset: true }).optional(),
  consent: z.object({
    /** The box the person ticked for texts. */
    sms: z.boolean(),
    email: z.boolean().optional(),
    /** The exact disclosure shown next to the box — the evidence. */
    language: z.string().trim().max(2000),
    pageUrl: z.string().url().max(500).optional(),
    ip: z.string().max(64).optional(),
  }).optional(),
});

export type LeadIntake = z.infer<typeof LeadIntakeSchema>;

export type ConsentVerdict = { sms: boolean; email: boolean; problems: string[] };

/**
 * Is this form's consent good enough to text the person automatically?
 *
 * Checks the three things TCPA prior express written consent has to contain.
 * Wording checks are deliberately simple and conservative: a false "no" holds
 * one text for a human; a false "yes" is $500–1,500 per message.
 */
export function evaluateFormConsent(
  consent: LeadIntake["consent"],
  businessName: string,
): ConsentVerdict {
  if (!consent) return { sms: false, email: false, problems: ["no consent captured on the form"] };

  const text = consent.language.toLowerCase().replace(/\s+/g, " ");
  const problems: string[] = [];

  if (!consent.sms) problems.push("the person did not tick the texting consent box");
  if (!text) {
    problems.push("no consent wording was sent with the lead");
  } else {
    if (!namesSeller(text, businessName)) {
      problems.push(`the consent wording does not name ${businessName} — consent must identify the seller`);
    }
    if (!/\b(text|texts|sms|message|messages|messaging)\b/.test(text)) {
      problems.push("the consent wording does not mention texts or messages");
    }
    if (!/not (a )?(condition|required)|not required to|isn't (a )?(condition|required)/.test(text)) {
      problems.push("the consent wording does not say consent is not a condition of purchase");
    }
  }

  return {
    sms: problems.length === 0,
    // Replying by email to someone's own enquiry is not marketing under
    // CAN-SPAM, CASL (implied consent from an enquiry) or PECR.
    email: true,
    problems,
  };
}

/**
 * Checkbox wording that passes evaluateFormConsent: names the seller, covers
 * automated texts, says consent is not a condition of purchase, and says how
 * to stop. Shown on /settings for the client to paste next to their form.
 */
export function recommendedConsentWording(businessName: string): string {
  return `By checking this box, I agree that ${businessName} may contact me by text message, ` +
    "including automated texts, at the number I provided. Consent is not a condition of purchase. " +
    "Message and data rates may apply. Reply STOP to opt out.";
}

/** "Northside Heating & Air" is named by "Northside Heating and Air" or "Northside". */
function namesSeller(text: string, businessName: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const name = norm(businessName);
  const body = norm(text);
  if (body.includes(name)) return true;
  // The distinctive first word is how people actually write it ("Northside").
  const first = name.split(" ")[0];
  return first.length >= 4 && new RegExp(`\\b${first}\\b`).test(body);
}

export type IntakeResult = {
  duplicate: boolean;
  leadId: string | null;
  contactId: string | null;
  conversationId: string | null;
  /**
   * sent: delivered to the carrier. held_for_review: drafted, waiting for a
   * person (no consent, or a guardrail). failed: allowed but the send failed.
   */
  firstResponse: "sent" | "held_for_review" | "failed" | "not_sent" | "manual_follow_up";
  consent: ConsentVerdict;
  reason?: string;
};

export async function intakeLead(tenantId: string, input: LeadIntake): Promise<IntakeResult> {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) throw new Error(`unknown tenant ${tenantId}`);
  const businessName = tenant.settings?.businessName ?? tenant.name;
  const country = tenant.country ?? "US";

  const phone = normalizePhone(input.phone ?? "", country);
  const email = normalizeEmail(input.email);
  const consent = evaluateFormConsent(input.consent, businessName);
  const empty: IntakeResult = {
    duplicate: false, leadId: null, contactId: null, conversationId: null,
    firstResponse: "not_sent", consent,
  };
  if (!phone && !email) return { ...empty, reason: "no usable phone or email" };

  // Marketplaces redeliver. Same source + id = the same lead.
  const dedupeKey = input.externalId ? `${input.source}:${input.externalId}` : null;
  if (dedupeKey) {
    const seen = await db.query.events.findFirst({
      where: and(
        eq(events.tenantId, tenantId),
        eq(events.type, "lead_intake"),
        sql`${events.payload}->>'dedupeKey' = ${dedupeKey}`,
      ),
    });
    if (seen) {
      const p = seen.payload as Record<string, unknown>;
      return {
        ...empty, duplicate: true,
        leadId: (p.leadId as string) ?? null,
        contactId: seen.contactId, conversationId: seen.conversationId,
        firstResponse: (p.firstResponse as IntakeResult["firstResponse"]) ?? "not_sent",
      };
    }
  }

  // A source's clock running fast must not put the lead in the future (the
  // SLA would come out negative).
  const now = new Date();
  const submittedAt = input.submittedAt && new Date(input.submittedAt) < now ? new Date(input.submittedAt) : now;
  const contact = await resolveContact(tenantId, {
    channel: phone ? "sms" : "email",
    externalId: (phone ?? email)!,
    name: input.name ?? null,
    phone,
    email,
  });

  // Record what the person agreed to. Never downgrade consent already on
  // file: an older, valid consent is not withdrawn by a weaker form.
  const consentPatch: Partial<typeof contacts.$inferInsert> = {};
  if (input.name && !contact.displayName) consentPatch.displayName = input.name;
  if (consent.sms && !contact.smsConsent) {
    consentPatch.smsConsent = true;
    consentPatch.consentSource =
      `${input.source} form${input.consent?.pageUrl ? ` at ${input.consent.pageUrl}` : ""}: ` +
      `"${input.consent!.language}"${input.consent?.ip ? ` (ip ${input.consent.ip})` : ""}`;
    consentPatch.consentAt = submittedAt;
  }
  if (input.consent?.email && !contact.emailConsent) consentPatch.emailConsent = true;
  if (Object.keys(consentPatch).length) {
    await db.update(contacts).set(consentPatch).where(eq(contacts.id, contact.id));
  }

  const summary = [input.service, input.message].filter(Boolean).join(" — ") || null;

  // Text if there is a phone, otherwise email. An email answering the
  // person's own enquiry is a service message (CAN-SPAM transactional, CASL
  // implied consent from an enquiry); a first text still needs written consent.
  const channel = phone ? "sms" : "email";
  const address = (phone ?? email)!;

  // The submission becomes the first inbound message, stamped with the time
  // the person submitted it, so the SLA clock measures what they experienced.
  const body = input.message
    ? (input.service ? `${input.service}: ${input.message}` : input.message)
    : `(Requested ${input.service ?? "a callback"} through the ${sourceLabel(input.source)} form.)`;
  const settings = tenant.settings ?? {};
  const firstName = input.name?.split(/\s+/)[0];
  const replyAfter = new Date();
  const ingested = await handleInbound({
    tenantId,
    channel,
    externalId: dedupeKey ? `intake:${dedupeKey}` : null,
    externalThreadId: null,
    from: { channel, externalId: address, name: input.name ?? null, phone, email },
    body,
    receivedAt: submittedAt,
    meta: {
      businessInitiated: true,
      transactional: channel === "email",
      subject: channel === "email" ? `Your ${input.service ? input.service + " " : ""}request — ${businessName}` : null,
      intakeSource: input.source,
      postalCode: input.postalCode ?? null,
      intro: `Hi${firstName ? ` ${firstName}` : ""}, it's ${settings.agentName ?? "the team"} at ${businessName} ` +
        `about your ${sourceLabel(input.source)} request.`,
      footer: channel === "sms" ? "Reply STOP to opt out." : "If you'd rather not hear from us, just reply \"unsubscribe\".",
    },
  });

  // The agent may already have recorded the lead (qualify_lead); keep its
  // assessment and add where it came from.
  const existing = await db.query.leads.findFirst({
    where: and(eq(leads.tenantId, tenantId), eq(leads.conversationId, ingested.conversationId)),
  });
  const leadId = existing
    ? (await db.update(leads).set({ source: input.source, updatedAt: new Date() })
        .where(eq(leads.id, existing.id)).returning())[0].id
    : (await db.insert(leads).values({
        tenantId, contactId: ingested.contactId, conversationId: ingested.conversationId,
        sourceChannel: channel, source: input.source, service: input.service ?? null, summary,
      }).returning())[0].id;

  // What actually happened to the reply, read from the message it produced
  // now. An existing thread has older replies, which must not count.
  const reply = ingested.duplicate ? null : await db.query.messages.findFirst({
    where: and(eq(messages.conversationId, ingested.conversationId), eq(messages.direction, "outbound"),
      gte(messages.createdAt, replyAfter)),
    orderBy: desc(messages.createdAt),
  });
  const firstResponse: IntakeResult["firstResponse"] =
    !reply ? "not_sent"
    : reply.status === "held_for_review" ? "held_for_review"
    : reply.status === "failed" ? "failed"
    : "sent";
  const reason =
    firstResponse === "sent" ? undefined
    : firstResponse === "held_for_review" && !consent.sms ? `not texted: ${consent.problems.join("; ")}`
    : firstResponse === "held_for_review" ? String(reply?.meta?.holdReason ?? "held for review")
    : firstResponse === "failed" ? reply?.error ?? "the send failed"
    : "the agent produced no reply";

  await logIntake(tenantId, ingested.contactId, ingested.conversationId, {
    dedupeKey, leadId, source: input.source, firstResponse, consent, reason: reason ?? null,
  });
  if (!ingested.duplicate) {
    await publish(tenantId, "lead.created", {
      lead_id: leadId, source: input.source, service: input.service ?? null, message: input.message ?? null,
      first_response: firstResponse, conversation_id: ingested.conversationId,
      contact: await contactData(ingested.contactId),
    });
  }

  return {
    duplicate: ingested.duplicate, leadId, contactId: ingested.contactId,
    conversationId: ingested.conversationId, firstResponse, consent, reason,
  };
}

async function logIntake(
  tenantId: string, contactId: string, conversationId: string | null, payload: Record<string, unknown>,
) {
  await db.insert(events).values({ tenantId, type: "lead_intake", contactId, conversationId, payload });
}

function sourceLabel(source: LeadIntake["source"]): string {
  return {
    website: "website", google_lsa: "Google", angi: "Angi", thumbtack: "Thumbtack",
    facebook_lead_ad: "Facebook", zapier: "online", other: "online",
  }[source];
}
