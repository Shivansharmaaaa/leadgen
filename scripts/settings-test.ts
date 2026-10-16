import { eq } from "drizzle-orm";
import { db, tenants, staff } from "@/server/db";
import {
  addWebhook, disableIntake, removeStaff, removeWebhook, rotateIntakeKey, setWebchatOrigins, updateBusiness, upsertStaff,
} from "@/server/settings";
import { POST as intake } from "@/app/api/leads/route";

/**
 * Owner settings: every rule the /settings page relies on.
 *
 *   npm run settings:test
 */
process.env.LLM_PROVIDER = "scripted";
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.WEBHOOKS_ALLOW_PRIVATE;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const slug = "settings-test";
  await db.delete(tenants).where(eq(tenants.slug, slug));
  const [tenant] = await db.insert(tenants).values({
    name: "Settings Test", slug, country: "US", timezone: "America/New_York",
    settings: { businessName: "Settings Test", agentName: "Alex", priceFloor: 89 },
  }).returning();
  const settings = async () => (await db.query.tenants.findFirst({ where: eq(tenants.id, tenant.id) }))!.settings ?? {};

  try {
    console.log("\nBusiness");
    check("saves a new name", (await updateBusiness(tenant.id, { businessName: "Settings Test HVAC", agentName: "Sam" })).ok);
    const s1 = await settings();
    check("and keeps every other setting", s1.businessName === "Settings Test HVAC" && s1.agentName === "Sam" && s1.priceFloor === 89);
    check("rejects a one-letter name", !(await updateBusiness(tenant.id, { businessName: "X" })).ok);
    await updateBusiness(tenant.id, { asrContext: "" });
    check("blank speech hints are removed, not stored empty", (await settings()).asrContext === undefined);

    console.log("\nTeam");
    check("adds a person, normalising the phone", (await upsertStaff(tenant.id, { name: "Dana", email: "Dana@Example.com", phone: "(617) 555-0101", onCall: true })).ok);
    const dana = await db.query.staff.findFirst({ where: eq(staff.tenantId, tenant.id) });
    check("stored as E.164 with a lower-case email", dana?.phone === "+16175550101" && dana.email === "dana@example.com" && dana.onCall === true);
    const dup = await upsertStaff(tenant.id, { name: "Dana 2", email: "dana@example.com" });
    check("the same email twice is refused with a sentence", !dup.ok && !dup.ok && dup.error.includes("already on the team"), dup.ok ? "" : dup.error);
    const badPhone = await upsertStaff(tenant.id, { name: "Sam", email: "sam@example.com", phone: "call me" });
    check("an unreadable phone is refused", !badPhone.ok);
    check("updates in place", (await upsertStaff(tenant.id, { id: dana!.id, name: "Dana W", email: "dana@example.com", onCall: false })).ok &&
      (await db.query.staff.findFirst({ where: eq(staff.id, dana!.id) }))?.onCall === false);
    await removeStaff(tenant.id, dana!.id);
    check("removes", (await db.query.staff.findMany({ where: eq(staff.tenantId, tenant.id) })).length === 0);

    console.log("\nLead intake key");
    const k1 = await rotateIntakeKey(tenant.id);
    const k2 = await rotateIntakeKey(tenant.id);
    const call = (key: string) => intake(new Request(`http://localhost/api/leads?tenant=${slug}`, {
      method: "POST", headers: { "content-type": "application/json", "x-intake-key": key },
      body: JSON.stringify({ source: "website", phone: "6175550123", message: "need a quote" }),
    }));
    check("keys are long and unguessable", (k2.value ?? "").length >= 30 && k1.value !== k2.value);
    check("the new key works", (await call(k2.value!)).status === 202);
    check("the replaced key stops working at once", (await call(k1.value!)).status === 401);
    await disableIntake(tenant.id);
    check("turning intake off refuses even the current key", (await call(k2.value!)).status === 401 && (await settings()).intakeKey === undefined);

    console.log("\nWebsite chat origins");
    const o = await setWebchatOrigins(tenant.id, "https://www.example.com/contact, https://example.com\nhttps://example.com/");
    check("normalised to origins, de-duplicated", o.ok && o.value?.join() === "https://www.example.com,https://example.com", o.ok ? o.value?.join() : o.error);
    check("http refused for a real site", !(await setWebchatOrigins(tenant.id, "http://example.com")).ok);
    check("http allowed for a local dev server", (await setWebchatOrigins(tenant.id, "http://localhost:3000")).ok);
    check("nonsense refused with a sentence", !(await setWebchatOrigins(tenant.id, "my website")).ok);

    console.log("\nWebhooks");
    const w = await addWebhook(tenant.id, "https://hooks.zapier.com/hooks/catch/123/abc", ["lead.created", "appointment.booked"]);
    check("a public https endpoint is added with a fresh secret", w.ok && (w.value ?? "").startsWith("whsec_"), w.ok ? "" : w.error);
    check("the same URL twice is refused", !(await addWebhook(tenant.id, "https://hooks.zapier.com/hooks/catch/123/abc", [])).ok);
    const internal = await addWebhook(tenant.id, "https://169.254.169.254/latest/meta-data", []);
    check("cloud metadata address refused at save time", !internal.ok, internal.ok ? "" : internal.error);
    check("http refused", !(await addWebhook(tenant.id, "http://example.com/hook", [])).ok);
    check("an unknown event name refused", !(await addWebhook(tenant.id, "https://example.com/hook", ["lead.deleted"])).ok);
    await removeWebhook(tenant.id, "https://hooks.zapier.com/hooks/catch/123/abc");
    check("removes", ((await settings()).webhooks ?? []).length === 0);
  } finally {
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
  }

  console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
