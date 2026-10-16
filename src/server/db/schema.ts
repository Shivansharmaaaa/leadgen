import {
  pgTable, pgEnum, uuid, text, timestamp, jsonb, integer, boolean,
  numeric, index, uniqueIndex, primaryKey, vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/* ────────────────────────────────────────────────────────────────────────────
 * Enums
 * ──────────────────────────────────────────────────────────────────────────── */

/** Every channel the platform can ingest from or send to. */
export const channelEnum = pgEnum("channel", [
  "webchat", "email", "sms", "voice", "instagram", "messenger", "whatsapp", "gbp_review",
]);

export const directionEnum = pgEnum("direction", ["inbound", "outbound"]);
export const authorTypeEnum = pgEnum("author_type", ["contact", "ai", "human", "system"]);
export const convStatusEnum = pgEnum("conv_status", ["open", "snoozed", "closed"]);
export const leadStatusEnum = pgEnum("lead_status", [
  "new", "qualified", "unqualified", "booked", "won", "lost",
]);
export const apptStatusEnum = pgEnum("appt_status", [
  "pending", "confirmed", "cancelled", "completed", "no_show",
]);
export const jobStatusEnum = pgEnum("job_status", ["pending", "running", "done", "failed", "dead"]);
export const msgStatusEnum = pgEnum("msg_status", [
  "received", "queued", "sent", "delivered", "read", "failed", "held_for_review",
]);

/* ────────────────────────────────────────────────────────────────────────────
 * Tenancy
 * ──────────────────────────────────────────────────────────────────────────── */

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  /** ISO 3166-1 alpha-2. Drives which compliance ruleset applies. */
  country: text("country").notNull().default("US"),
  timezone: text("timezone").notNull().default("America/New_York"),
  vertical: text("vertical").notNull().default("home_services"),
  plan: text("plan").notNull().default("voice"),
  /** Per-tenant agent behaviour knobs (tone, escalation thresholds, price guards). */
  settings: jsonb("settings").$type<TenantSettings>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TenantSettings = {
  businessName?: string;
  agentName?: string;
  tone?: "warm" | "professional" | "casual";
  /** Hard guard: agent may never quote outside this range. */
  priceFloor?: number;
  priceCeiling?: number;
  currency?: "USD" | "CAD" | "GBP";
  /** Topics that force an immediate human handoff. */
  escalationTriggers?: string[];
  /** Replies above this confidence send automatically; below, they queue for review. */
  autoSendThreshold?: number;
  afterHoursOnly?: boolean;
  recordCalls?: boolean;
  /**
   * What speech recognition gets wrong for this trade, read into the voice
   * prompt after "in light of the fact that": e.g. "this is a heating and
   * cooling business: 'an answer' is almost certainly 'an AC'".
   */
  asrContext?: string;
  /**
   * Shared secret for POST /api/leads (web forms, Zapier, lead marketplaces).
   * Unset means intake is off for this tenant.
   */
  intakeKey?: string;
};

export const locations = pgTable("locations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  addressLine1: text("address_line1"),
  city: text("city"),
  region: text("region"),
  postalCode: text("postal_code"),
  country: text("country").notNull().default("US"),
  phone: text("phone"),
  timezone: text("timezone").notNull().default("America/New_York"),
  /** [{ day: 0-6, open: "08:00", close: "17:00" }] — read by the availability tool. */
  hours: jsonb("hours").$type<BusinessHours[]>().notNull().default(sql`'[]'::jsonb`),
  serviceArea: jsonb("service_area").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
}, (t) => [index("locations_tenant_idx").on(t.tenantId)]);

export type BusinessHours = { day: number; open: string; close: string };

export const staff = pgTable("staff", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull().default("agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("staff_tenant_email_idx").on(t.tenantId, t.email)]);

/* ────────────────────────────────────────────────────────────────────────────
 * Channel accounts — per-tenant credentials for each connected platform
 * ──────────────────────────────────────────────────────────────────────────── */

export const channelAccounts = pgTable("channel_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  channel: channelEnum("channel").notNull(),
  /** Page id, IG business id, E.164 number, inbound email address — the thing webhooks key on. */
  externalAccountId: text("external_account_id").notNull(),
  displayName: text("display_name"),
  /** Tokens live here. Encrypted at rest by the app layer, never returned to the browser. */
  credentials: jsonb("credentials").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("channel_accounts_lookup_idx").on(t.channel, t.externalAccountId),
  index("channel_accounts_tenant_idx").on(t.tenantId),
]);

/* ────────────────────────────────────────────────────────────────────────────
 * Contact graph — one human, many channel identities
 * ──────────────────────────────────────────────────────────────────────────── */

export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  displayName: text("display_name"),
  primaryEmail: text("primary_email"),
  primaryPhone: text("primary_phone"),
  tags: jsonb("tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  notes: text("notes"),

  /* Consent — the thing that keeps outbound legal in US/CA/UK. */
  smsConsent: boolean("sms_consent").notNull().default(false),
  emailConsent: boolean("email_consent").notNull().default(false),
  callRecordingConsent: boolean("call_recording_consent").notNull().default(false),
  /** Free text proving where consent came from; required evidence under TCPA/CASL. */
  consentSource: text("consent_source"),
  consentAt: timestamp("consent_at", { withTimezone: true }),
  doNotContact: boolean("do_not_contact").notNull().default(false),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("contacts_tenant_idx").on(t.tenantId),
  index("contacts_phone_idx").on(t.tenantId, t.primaryPhone),
  index("contacts_email_idx").on(t.tenantId, t.primaryEmail),
]);

/**
 * The join that makes cross-channel identity work: an Instagram handle and a
 * phone number both point at one contact row.
 */
export const contactIdentities = pgTable("contact_identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  channel: channelEnum("channel").notNull(),
  /** Normalised: E.164 for phone, lowercased for email, raw platform id otherwise. */
  externalId: text("external_id").notNull(),
  handle: text("handle"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("contact_identities_unique_idx").on(t.tenantId, t.channel, t.externalId),
  index("contact_identities_contact_idx").on(t.contactId),
]);

/* ────────────────────────────────────────────────────────────────────────────
 * Conversations & messages — the canonical pipeline
 * ──────────────────────────────────────────────────────────────────────────── */

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  channel: channelEnum("channel").notNull(),
  status: convStatusEnum("status").notNull().default("open"),
  subject: text("subject"),
  /** Platform thread id (email Message-ID root, IG thread, call SID). */
  externalThreadId: text("external_thread_id"),
  /** Null means the AI owns this thread; set means a human took over. */
  assignedStaffId: uuid("assigned_staff_id").references(() => staff.id, { onDelete: "set null" }),
  aiPaused: boolean("ai_paused").notNull().default(false),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
  /** Meta/WhatsApp 24h service window — after this, only templates may be sent. */
  windowExpiresAt: timestamp("window_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("conversations_tenant_idx").on(t.tenantId, t.lastMessageAt),
  index("conversations_contact_idx").on(t.contactId),
  uniqueIndex("conversations_thread_idx").on(t.tenantId, t.channel, t.externalThreadId),
]);

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  direction: directionEnum("direction").notNull(),
  channel: channelEnum("channel").notNull(),
  authorType: authorTypeEnum("author_type").notNull(),
  authorStaffId: uuid("author_staff_id").references(() => staff.id, { onDelete: "set null" }),
  body: text("body").notNull().default(""),
  media: jsonb("media").$type<MediaAttachment[]>().notNull().default(sql`'[]'::jsonb`),
  /** Provider message id. Unique per tenant so webhook redelivery can't double-insert. */
  externalId: text("external_id"),
  status: msgStatusEnum("status").notNull().default("received"),
  error: text("error"),
  meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("messages_conversation_idx").on(t.conversationId, t.createdAt),
  uniqueIndex("messages_external_idx").on(t.tenantId, t.channel, t.externalId),
]);

export type MediaAttachment = { type: string; url: string; mimeType?: string; name?: string };

/* ────────────────────────────────────────────────────────────────────────────
 * Outcomes — leads, appointments, calls
 * ──────────────────────────────────────────────────────────────────────────── */

export const leads = pgTable("leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  status: leadStatusEnum("status").notNull().default("new"),
  /** 0-100, set by the agent's qualify tool against the tenant's own criteria. */
  score: integer("score").notNull().default(0),
  service: text("service"),
  intent: text("intent"),
  urgency: text("urgency"),
  estimatedValue: numeric("estimated_value", { precision: 12, scale: 2 }),
  sourceChannel: channelEnum("source_channel").notNull(),
  /** Where the lead came from beyond its channel: "website", "google_lsa", "angi"... */
  source: text("source"),
  summary: text("summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("leads_tenant_idx").on(t.tenantId, t.createdAt)]);

export const appointments = pgTable("appointments", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
  locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
  service: text("service").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  status: apptStatusEnum("status").notNull().default("confirmed"),
  notes: text("notes"),
  externalCalendarId: text("external_calendar_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("appointments_tenant_idx").on(t.tenantId, t.startsAt)]);

export const calls = pgTable("calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  direction: directionEnum("direction").notNull(),
  providerCallId: text("provider_call_id").notNull(),
  fromNumber: text("from_number").notNull(),
  toNumber: text("to_number").notNull(),
  durationSeconds: integer("duration_seconds"),
  recordingUrl: text("recording_url"),
  transcript: jsonb("transcript").$type<TranscriptTurn[]>().notNull().default(sql`'[]'::jsonb`),
  outcome: text("outcome"),
  answeredByAi: boolean("answered_by_ai").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("calls_provider_idx").on(t.providerCallId),
  index("calls_tenant_idx").on(t.tenantId, t.createdAt),
]);

export type TranscriptTurn = { role: "caller" | "agent"; text: string; at: string };

/* ────────────────────────────────────────────────────────────────────────────
 * Knowledge — structured facts the agent may never paraphrase, plus prose
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Hard facts. The agent reads these as data and is forbidden from inventing
 * values for these keys. This is what stops hallucinated prices and hours.
 */
export const knowledgeFacts = pgTable("knowledge_facts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("knowledge_facts_unique_idx").on(t.tenantId, t.category, t.key)]);

/**
 * Prose. Small enough per tenant that the whole set goes into the cached system
 * prompt; `searchKnowledge` falls back to full-text search past the budget.
 */
export const knowledgeDocs = pgTable("knowledge_docs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  sourceUrl: text("source_url"),
  content: text("content").notNull(),
  tokenEstimate: integer("token_estimate").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("knowledge_docs_tenant_idx").on(t.tenantId)]);

/* ────────────────────────────────────────────────────────────────────────────
 * Observability — every agent turn is auditable
 * ──────────────────────────────────────────────────────────────────────────── */

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
  inboundMessageId: uuid("inbound_message_id").references(() => messages.id, { onDelete: "set null" }),
  model: text("model").notNull(),
  /** Ordered record of every tool the agent called this turn, with inputs and results. */
  toolCalls: jsonb("tool_calls").$type<ToolCallRecord[]>().notNull().default(sql`'[]'::jsonb`),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  latencyMs: integer("latency_ms").notNull().default(0),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
  outcome: text("outcome").notNull().default("replied"),
  stopReason: text("stop_reason"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("agent_runs_tenant_idx").on(t.tenantId, t.createdAt)]);

export type ToolCallRecord = {
  name: string;
  input: unknown;
  output: unknown;
  ms: number;
  blocked?: string;
};

/** Append-only analytics log. Everything the ROI dashboard counts comes from here. */
export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("events_tenant_type_idx").on(t.tenantId, t.type, t.createdAt)]);

/* ────────────────────────────────────────────────────────────────────────────
 * Durable job queue — follow-ups, retries, syncs. Postgres-backed, no Redis.
 * ──────────────────────────────────────────────────────────────────────────── */

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
  status: jobStatusEnum("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lastError: text("last_error"),
  /** Dedupe key so the same follow-up can't be scheduled twice. */
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("jobs_poll_idx").on(t.status, t.runAt),
  uniqueIndex("jobs_idem_idx").on(t.idempotencyKey),
]);

/** Raw webhook receipts, kept for replay and for proving idempotency. */
export const webhookReceipts = pgTable("webhook_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(),
  externalId: text("external_id").notNull(),
  payload: jsonb("payload").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("webhook_receipts_unique_idx").on(t.provider, t.externalId)]);

/* ────────────────────────────────────────────────────────────────────────────
 * Cross-tenant learning
 *
 * The network effect: every client's outcomes improve scoring for every other
 * client in the same vertical — WITHOUT any personal data crossing a tenant
 * boundary. Only de-identified feature vectors and labels are pooled.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One row per lead, holding only categorical/numeric signal. Deliberately has
 * no name, phone, email, message text, or free-form field: nothing here can
 * re-identify a person, which is what makes pooling it lawful.
 */
export const leadFeatures = pgTable("lead_features", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  leadId: uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),

  /* Pooling scope — models are trained per vertical+country, never globally. */
  vertical: text("vertical").notNull(),
  country: text("country").notNull(),

  /* Signal. All low-cardinality categoricals or bounded numbers. */
  sourceChannel: channelEnum("source_channel").notNull(),
  hourOfDay: integer("hour_of_day").notNull(),
  dayOfWeek: integer("day_of_week").notNull(),
  afterHours: boolean("after_hours").notNull().default(false),
  /** Seconds between the customer's first message and the first reply. */
  responseLatencySec: integer("response_latency_sec"),
  inboundMessageCount: integer("inbound_message_count").notNull().default(0),
  serviceCategory: text("service_category"),
  urgency: text("urgency"),
  gavePhone: boolean("gave_phone").notNull().default(false),
  gaveEmail: boolean("gave_email").notNull().default(false),
  askedPrice: boolean("asked_price").notNull().default(false),
  isReturningCustomer: boolean("is_returning_customer").notNull().default(false),
  /** Coarse only — first 3 chars of postcode at most. Never a full address. */
  geoBucket: text("geo_bucket"),

  /* Label, filled in when the outcome is known. */
  converted: boolean("converted"),
  conversionValue: numeric("conversion_value", { precision: 12, scale: 2 }),
  labeledAt: timestamp("labeled_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("lead_features_lead_idx").on(t.leadId),
  index("lead_features_scope_idx").on(t.vertical, t.country, t.converted),
]);

/** Trained logistic-regression weights, one row per vertical+country+version. */
export const modelWeights = pgTable("model_weights", {
  id: uuid("id").primaryKey().defaultRandom(),
  vertical: text("vertical").notNull(),
  country: text("country").notNull(),
  /** Null = the pooled global model; set = a single tenant's own model. */
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  weights: jsonb("weights").$type<Record<string, number>>().notNull(),
  bias: numeric("bias", { precision: 10, scale: 6 }).notNull().default("0"),
  sampleSize: integer("sample_size").notNull().default(0),
  baseRate: numeric("base_rate", { precision: 6, scale: 5 }).notNull().default("0"),
  auc: numeric("auc", { precision: 5, scale: 4 }),
  trainedAt: timestamp("trained_at", { withTimezone: true }).notNull().defaultNow(),
  active: boolean("active").notNull().default(true),
}, (t) => [index("model_weights_scope_idx").on(t.vertical, t.country, t.tenantId, t.active)]);

/* ────────────────────────────────────────────────────────────────────────────
 * Referrals — the ONLY lawful route for passing a person between tenants.
 *
 * A contact must affirmatively opt in, naming the category of business they
 * want to hear from, in the conversation where they were asked. Consent given
 * to business A never silently transfers to business B: TCPA, CASL, UK PECR
 * and GDPR all treat that as a different sender requiring its own permission.
 * ──────────────────────────────────────────────────────────────────────────── */

export const referralConsents = pgTable("referral_consents", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The tenant that collected the consent. */
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  /** Categories the customer agreed to, e.g. ["plumbing","electrical"]. */
  categories: jsonb("categories").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  /** The customer's own words. Required evidence if ever challenged. */
  quote: text("quote").notNull(),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, (t) => [index("referral_consents_contact_idx").on(t.contactId)]);

/** An explicit, agreed partnership. Both sides opt in; no implicit networks. */
export const partnerLinks = pgTable("partner_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  fromTenantId: uuid("from_tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  toTenantId: uuid("to_tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("partner_links_unique_idx").on(t.fromTenantId, t.toTenantId, t.category)]);

/** A referral actually made, for audit and for revenue share. */
export const referrals = pgTable("referrals", {
  id: uuid("id").primaryKey().defaultRandom(),
  fromTenantId: uuid("from_tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  toTenantId: uuid("to_tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  consentId: uuid("consent_id").notNull().references(() => referralConsents.id, { onDelete: "restrict" }),
  category: text("category").notNull(),
  status: text("status").notNull().default("sent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ────────────────────────────────────────────────────────────────────────────
 * Retrieval
 *
 * Tiered on purpose. A single-location business has a knowledge base of a few
 * thousand tokens, and putting all of it in a cached system prompt beats
 * retrieval on both accuracy and latency — there is no wrong-chunk failure
 * mode. Retrieval earns its place above that threshold: multi-location chains,
 * large service catalogues, and past-job history that grows without bound.
 * ──────────────────────────────────────────────────────────────────────────── */

export const knowledgeChunks = pgTable("knowledge_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  docId: uuid("doc_id").notNull().references(() => knowledgeDocs.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull().default(0),
  content: text("content").notNull(),
  tokenEstimate: integer("token_estimate").notNull().default(0),
  /** 768 dims = nomic-embed-text, the free local default. */
  embedding: vector("embedding", { dimensions: 768 }),
  embeddingModel: text("embedding_model"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("knowledge_chunks_tenant_idx").on(t.tenantId),
  index("knowledge_chunks_doc_idx").on(t.docId),
]);

/* ────────────────────────────────────────────────────────────────────────────
 * Per-contact memory
 *
 * Durable facts about a person that outlive any single conversation: what
 * equipment they own, where the side gate key is, that they can only take
 * calls after 5pm. Transcript history is not memory — it grows without bound
 * and the model has to re-derive the same facts every turn.
 *
 * Two properties the 2026 memory literature insists on, both modelled here:
 * memory must be SUPERSEDABLE (a fact replaced by a newer one must stop being
 * retrieved, not merely rank lower), and it must carry PROVENANCE, so a wrong
 * fact can be traced to the message that produced it.
 * ──────────────────────────────────────────────────────────────────────────── */

export const memoryKindEnum = pgEnum("memory_kind", [
  "equipment",    // "Carrier 3-ton AC, installed 2019"
  "property",     // "side gate code 4471", "unit is on the roof"
  "preference",   // "prefers texts, not calls"
  "constraint",   // "works nights, only available after 5pm"
  "relationship", // "landlord pays, tenant schedules"
  "history",      // "we replaced the condenser in 2024"
  "caution",      // "dog in the yard", "previous complaint about punctuality"
]);

export const contactMemories = pgTable("contact_memories", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  kind: memoryKindEnum("kind").notNull(),
  /** Short stable slug so a newer value can supersede an older one. */
  key: text("key").notNull(),
  value: text("value").notNull(),
  /** 0-1. Agent-asserted facts start high; inferred ones start lower. */
  confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull().default("0.80"),

  /* Provenance — which message produced this claim. */
  sourceConversationId: uuid("source_conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  sourceMessageId: uuid("source_message_id").references(() => messages.id, { onDelete: "set null" }),
  /** How it was captured: "agent_tool" | "deterministic" | "staff". */
  origin: text("origin").notNull().default("agent_tool"),

  /** Set when a newer memory replaces this one. Superseded rows are never retrieved. */
  supersededById: uuid("superseded_by_id"),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),

  lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("contact_memories_contact_idx").on(t.contactId, t.supersededAt),
  index("contact_memories_tenant_idx").on(t.tenantId),
]);

/* ────────────────────────────────────────────────────────────────────────────
 * Incrementality
 *
 * Borrowed from how ad platforms actually measure themselves. Meta's auction
 * ranks on total value = bid x estimated action rate x quality, but its
 * *measurement* side learned a harder lesson: predicted conversion is the
 * wrong objective. What matters is causal lift — did contacting this person
 * change the outcome?
 *
 * Ranking a call-back list by P(convert) wastes effort on two groups: people
 * who would have booked anyway, and people who never will. The value is in the
 * persuadables. Measuring that needs a holdout, so every outreach campaign
 * randomly withholds a slice and compares.
 * ──────────────────────────────────────────────────────────────────────────── */

export const cohortEnum = pgEnum("cohort", ["treatment", "holdout"]);

export const outreachAssignments = pgTable("outreach_assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
  /** Groups assignments so lift is computed within a comparable population. */
  campaign: text("campaign").notNull(),
  cohort: cohortEnum("cohort").notNull(),
  /** Model score at assignment time — lets lift be measured per score decile. */
  scoreAtAssignment: integer("score_at_assignment").notNull().default(0),
  contactedAt: timestamp("contacted_at", { withTimezone: true }),
  converted: boolean("converted").notNull().default(false),
  convertedAt: timestamp("converted_at", { withTimezone: true }),
  conversionValue: numeric("conversion_value", { precision: 12, scale: 2 }),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("outreach_campaign_idx").on(t.tenantId, t.campaign, t.cohort),
  uniqueIndex("outreach_unique_idx").on(t.campaign, t.contactId),
]);
