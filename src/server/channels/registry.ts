import type { Channel, ChannelAdapter } from "@/server/core/types";
import { webchatAdapter } from "./webchat";
import { smsAdapter, voiceAdapter } from "./twilio";
import { instagramAdapter, messengerAdapter, whatsappAdapter } from "./meta";

/**
 * Egress registry. Adding a platform is: implement ChannelAdapter, register it
 * here. Nothing in ingest, the agent, or the inbox changes.
 */
const adapters = new Map<Channel, ChannelAdapter>();

export function registerAdapter(adapter: ChannelAdapter) {
  adapters.set(adapter.channel, adapter);
}

export function getAdapter(channel: Channel): ChannelAdapter | undefined {
  return adapters.get(channel);
}

registerAdapter(webchatAdapter);
registerAdapter(smsAdapter);
registerAdapter(voiceAdapter);
registerAdapter(instagramAdapter);
registerAdapter(messengerAdapter);
registerAdapter(whatsappAdapter);

export { adapters };
