import type { MediaAttachment } from "@/server/db/schema";

export type Channel =
  | "webchat" | "email" | "sms" | "voice"
  | "instagram" | "messenger" | "whatsapp" | "gbp_review";

/** How a human appears on one specific platform. */
export type ChannelIdentity = {
  channel: Channel;
  /** Platform-native id. Normalised before it reaches this type. */
  externalId: string;
  handle?: string | null;
  name?: string | null;
  /** Extra identifiers the platform happened to give us — used to merge contacts. */
  email?: string | null;
  phone?: string | null;
};

/**
 * The canonical inbound event. Every adapter normalises to this, and nothing
 * downstream of ingest knows which platform a message came from.
 */
export type InboundMessage = {
  tenantId: string;
  channel: Channel;
  /** Provider message id. The uniqueness key that makes redelivery safe. */
  externalId: string | null;
  externalThreadId: string | null;
  from: ChannelIdentity;
  body: string;
  media?: MediaAttachment[];
  receivedAt?: Date;
  meta?: Record<string, unknown>;
};

export type OutboundMessage = {
  tenantId: string;
  conversationId: string;
  channel: Channel;
  to: ChannelIdentity;
  body: string;
  media?: MediaAttachment[];
  meta?: Record<string, unknown>;
};

export type SendResult = { externalId?: string | null; status: "sent" | "failed"; error?: string };

/**
 * Per-channel egress. Adding a platform means implementing this and registering
 * it — no changes anywhere else in the pipeline.
 */
export interface ChannelAdapter {
  channel: Channel;
  /** Platform formatting limits, applied before send. */
  maxLength?: number;
  /**
   * Window / template checks (Meta's 24h rule, SMS consent, DNC) run here.
   * Returning ok:false holds the message instead of sending it.
   */
  canSend?(msg: OutboundMessage): Promise<{ ok: boolean; reason?: string }>;
  send(msg: OutboundMessage): Promise<SendResult>;
}
