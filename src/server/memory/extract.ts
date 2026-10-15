import { remember } from "./store";

/**
 * Deterministic memory extraction.
 *
 * Runs on every inbound message, before the agent. The same reasoning as
 * identity extraction: a model will sometimes forget to call `remember`, but a
 * regex that spots "the unit is on the roof" never does. The agent's tool
 * handles judgement calls; this handles the obvious ones for free.
 *
 * Deliberately narrow. A false memory is worse than a missing one — a wrong
 * gate code sends a technician to a locked yard.
 */
type Pattern = {
  kind: Parameters<typeof remember>[0]["kind"];
  key: string;
  re: RegExp;
  confidence: number;
  format?: (m: RegExpMatchArray) => string;
};

const PATTERNS: Pattern[] = [
  {
    kind: "property", key: "access_code",
    re: /\b(?:gate|door|lock ?box|key ?pad|entry)\s+(?:code|combo|combination)\s+(?:is\s+)?([A-Za-z0-9#*]{3,10})\b/i,
    confidence: 0.9,
    format: (m) => `Access code: ${m[1]}`,
  },
  {
    kind: "property", key: "unit_location",
    re: /\b(?:unit|system|condenser|furnace|boiler|ac)\s+is\s+(?:located\s+)?(?:on|in)\s+the\s+(roof|basement|attic|crawl ?space|garage|side of the house|back yard|backyard)\b/i,
    confidence: 0.85,
    format: (m) => `Unit is in/on the ${m[1]}`,
  },
  {
    kind: "caution", key: "dog_on_property",
    re: /\b(?:i|we)\s+have\s+(?:a|two|three|\d+)?\s*dogs?\b|\bdog\s+in\s+the\s+(?:yard|garden|back)\b/i,
    confidence: 0.85,
    format: () => "Dog on the property",
  },
  {
    kind: "equipment", key: "system_brand",
    re: /\b(carrier|trane|lennox|rheem|goodman|york|daikin|mitsubishi|bryant|american standard|bosch|worcester|vaillant|ideal)\b/i,
    confidence: 0.75,
    format: (m) => `System brand: ${titleCase(m[1])}`,
  },
  {
    kind: "equipment", key: "system_age",
    re: /\b(?:installed|put in|fitted|replaced)\s+(?:in\s+)?(19\d{2}|20\d{2})\b/i,
    confidence: 0.8,
    format: (m) => `System installed ${m[1]}`,
  },
  {
    kind: "constraint", key: "availability_window",
    re: /\b(?:only|i'?m only)\s+(?:available|free|home|around)\s+(after|before)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
    confidence: 0.8,
    format: (m) => `Only available ${m[1].toLowerCase()} ${m[2]}`,
  },
  {
    kind: "preference", key: "contact_preference",
    re: /\b(?:please\s+)?(?:don'?t\s+call|no\s+calls?|text\s+me\s+(?:instead|only)|prefer\s+(?:text|email|whatsapp))\b/i,
    confidence: 0.85,
    format: (m) => `Contact preference: ${m[0].trim()}`,
  },
  {
    kind: "relationship", key: "decision_maker",
    re: /\b(?:i'?m\s+the\s+tenant|my\s+landlord|the\s+landlord\s+(?:pays|handles)|i'?m\s+renting|property\s+manager)\b/i,
    confidence: 0.8,
    format: (m) => `Decision-maker note: ${m[0].trim()}`,
  },
];

export async function extractMemories(args: {
  tenantId: string;
  contactId: string;
  text: string;
  conversationId?: string;
  messageId?: string;
}): Promise<number> {
  let written = 0;

  for (const p of PATTERNS) {
    const match = args.text.match(p.re);
    if (!match) continue;

    const value = p.format ? p.format(match) : match[0];
    const res = await remember({
      tenantId: args.tenantId,
      contactId: args.contactId,
      kind: p.kind,
      key: p.key,
      value,
      confidence: p.confidence,
      conversationId: args.conversationId ?? null,
      messageId: args.messageId ?? null,
      origin: "deterministic",
    });
    if (res.created) written++;
  }

  return written;
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
