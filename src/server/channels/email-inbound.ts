/**
 * Reading an inbound email: who sent it, what they actually wrote this time,
 * and whether a person wrote it at all.
 *
 * The last one matters most. An AI that answers an out-of-office reply gets
 * another out-of-office back, forever, at the client's expense and to their
 * reputation. Anything that declares itself automatic (RFC 3834
 * Auto-Submitted, Precedence: bulk/list/junk, X-Autoreply, a mailer-daemon
 * or no-reply sender, a bounce) is stored but never answered.
 */

export type ParsedAddress = { address: string; name: string | null };

/** "Priya Patel <Priya@Example.com>" → { address: "priya@example.com", name: "Priya Patel" } */
export function parseAddress(raw: string | null | undefined): ParsedAddress | null {
  if (!raw) return null;
  const angle = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const address = (angle ? angle[2] : raw).trim().toLowerCase();
  if (!/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(address)) return null;
  const name = angle?.[1]?.trim() || null;
  return { address, name };
}

/** Every address in a To/Cc header, for matching the tenant's inbound address. */
export function parseAddressList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((p) => parseAddress(p)?.address).filter((a): a is string => Boolean(a));
}

/**
 * The new text only: drop the quoted thread below "On ... wrote:", ">"
 * lines, and a signature after "-- ". The agent should answer what they
 * said now, not re-read its own earlier replies as theirs.
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // "On Fri, 16 Oct 2026, Priya <p@x.com> wrote:", which Gmail often wraps onto two lines.
    if (/^\s*On\s.+wrote:\s*$/.test(line)) break;
    if (/^\s*On\s/.test(line) && /wrote:\s*$/.test(lines[i + 1] ?? "") && line.length > 20) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^_{5,}$/.test(line.trim())) break;
    if (/^From: .+/.test(line) && out.length && /^(Sent|Date): /.test(lines[i + 1] ?? "")) break;
    if (line === "-- " || line === "--") break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

/** The value of one header from a raw header block (unfolded). */
export function header(raw: string | null | undefined, name: string): string | null {
  if (!raw) return null;
  const unfolded = raw.replace(/\r?\n[ \t]+/g, " ");
  const m = unfolded.match(new RegExp(`^${name}:\\s*(.*)$`, "im"));
  return m ? m[1].trim() : null;
}

export function isAutomated(from: string, headers: string | null | undefined): string | null {
  const auto = header(headers, "Auto-Submitted");
  if (auto && auto.toLowerCase() !== "no") return `Auto-Submitted: ${auto}`;
  const precedence = header(headers, "Precedence");
  if (precedence && /bulk|list|junk|auto_reply/i.test(precedence)) return `Precedence: ${precedence}`;
  if (header(headers, "X-Autoreply") || header(headers, "X-Autorespond")) return "X-Autoreply";
  if (header(headers, "List-Id") || header(headers, "List-Unsubscribe")) return "mailing list";
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?)[@+.-]/i.test(from)) return `sender ${from}`;
  return null;
}
