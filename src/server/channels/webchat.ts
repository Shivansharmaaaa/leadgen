import type { ChannelAdapter, OutboundMessage, SendResult } from "@/server/core/types";

/**
 * The website widget. Delivery is the message row itself — the browser reads
 * the conversation back — so sending is a no-op that always succeeds.
 */
export const webchatAdapter: ChannelAdapter = {
  channel: "webchat",
  maxLength: 2000,
  async send(_msg: OutboundMessage): Promise<SendResult> {
    return { status: "sent", externalId: null };
  },
};
