import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, channelAccounts, conversations } from "@/server/db";
import type { ChannelAdapter, OutboundMessage, SendResult, Channel } from "@/server/core/types";

const GRAPH = "https://graph.facebook.com/v21.0";

/**
 * Instagram DM / Messenger / WhatsApp egress.
 *
 * The 24-hour rule is enforced in `canSend`, not hoped for: outside the
 * service window Meta rejects a free-form send, and repeatedly tripping that
 * is a route to losing the app's messaging permission.
 */
function metaAdapter(channel: Extract<Channel, "instagram" | "messenger" | "whatsapp">): ChannelAdapter {
  return {
    channel,
    maxLength: 980,

    async canSend(msg: OutboundMessage) {
      const convo = await db.query.conversations.findFirst({
        where: eq(conversations.id, msg.conversationId),
      });
      if (!convo?.windowExpiresAt) return { ok: true };
      if (convo.windowExpiresAt > new Date()) return { ok: true };
      return {
        ok: false,
        reason:
          "outside Meta's 24-hour service window — needs an approved template " +
          "or the human agent tag",
      };
    },

    async send(msg: OutboundMessage): Promise<SendResult> {
      const account = await db.query.channelAccounts.findFirst({
        where: and(
          eq(channelAccounts.tenantId, msg.tenantId),
          eq(channelAccounts.channel, channel),
        ),
      });
      const token = account?.credentials?.pageAccessToken ?? process.env.META_PAGE_ACCESS_TOKEN;
      const senderId = account?.externalAccountId;

      if (!token || !senderId) {
        return { status: "failed", error: `no ${channel} account connected for this tenant` };
      }

      const url =
        channel === "whatsapp"
          ? `${GRAPH}/${senderId}/messages`
          : `${GRAPH}/${senderId}/messages`;

      const payload =
        channel === "whatsapp"
          ? {
              messaging_product: "whatsapp",
              to: msg.to.externalId,
              type: "text",
              text: { body: msg.body },
            }
          : {
              recipient: { id: msg.to.externalId },
              message: { text: msg.body },
              messaging_type: "RESPONSE",
            };

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        });
        const json = (await res.json()) as { message_id?: string; messages?: { id: string }[]; error?: { message: string } };

        if (!res.ok || json.error) {
          return { status: "failed", error: json.error?.message ?? `HTTP ${res.status}` };
        }
        return { status: "sent", externalId: json.message_id ?? json.messages?.[0]?.id ?? null };
      } catch (err) {
        return { status: "failed", error: err instanceof Error ? err.message : "meta send failed" };
      }
    },
  };
}

export const instagramAdapter = metaAdapter("instagram");
export const messengerAdapter = metaAdapter("messenger");
export const whatsappAdapter = metaAdapter("whatsapp");

/* ────────────────────────────────────────────────────────────────────────────
 * FEATURE 3 — comment-to-DM
 *
 * Someone comments "price?" on a post. The agent replies publicly (social
 * proof, and it signals responsiveness to the algorithm) and simultaneously
 * opens a private DM where the actual qualification happens.
 *
 * This is the single best social lead-gen demo there is, and it needs the
 * `instagram_manage_comments` permission on top of messaging.
 * ──────────────────────────────────────────────────────────────────────────── */

export async function replyToComment(args: {
  tenantId: string;
  commentId: string;
  publicReply: string;
}): Promise<{ ok: boolean; error?: string }> {
  const account = await db.query.channelAccounts.findFirst({
    where: and(eq(channelAccounts.tenantId, args.tenantId), eq(channelAccounts.channel, "instagram")),
  });
  const token = account?.credentials?.pageAccessToken ?? process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) return { ok: false, error: "no Instagram account connected" };

  const res = await fetch(`${GRAPH}/${args.commentId}/replies`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: args.publicReply }),
  });
  if (!res.ok) return { ok: false, error: await res.text() };
  return { ok: true };
}

/** Open a private DM off the back of a public comment. */
export async function dmCommenter(args: {
  tenantId: string;
  commentId: string;
  message: string;
}): Promise<{ ok: boolean; error?: string }> {
  const account = await db.query.channelAccounts.findFirst({
    where: and(eq(channelAccounts.tenantId, args.tenantId), eq(channelAccounts.channel, "instagram")),
  });
  const token = account?.credentials?.pageAccessToken ?? process.env.META_PAGE_ACCESS_TOKEN;
  const igId = account?.externalAccountId;
  if (!token || !igId) return { ok: false, error: "no Instagram account connected" };

  const res = await fetch(`${GRAPH}/${igId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      recipient: { comment_id: args.commentId },
      message: { text: args.message },
    }),
  });
  if (!res.ok) return { ok: false, error: await res.text() };
  return { ok: true };
}

/** Intent triage for a public comment — decides whether it is worth a DM. */
export function classifyComment(text: string): {
  isLead: boolean; publicReply: string; dmOpener: string | null;
} {
  const t = text.toLowerCase();
  const priceIntent = /\b(price|cost|how much|quote|\$|£|rates?)\b/.test(t);
  const availIntent = /\b(available|book|appointment|when can|schedule|slot)\b/.test(t);
  const serviceIntent = /\b(do you|can you|service|fix|repair|install)\b/.test(t);

  if (priceIntent || availIntent || serviceIntent) {
    return {
      isLead: true,
      publicReply: "Just sent you a DM with the details! 📩",
      dmOpener:
        "Hey! Saw your comment — happy to help. What are you looking to get done, " +
        "and whereabouts are you based?",
    };
  }
  if (/\b(thank|great|amazing|love|recommend|best)\b/.test(t)) {
    return { isLead: false, publicReply: "Thank you — really appreciate that! 🙏", dmOpener: null };
  }
  return { isLead: false, publicReply: "", dmOpener: null };
}

/** Meta signs webhooks with the app secret. Reject anything unsigned. */
export function verifyMetaSignature(rawBody: string, header: string | null): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret || !header) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
