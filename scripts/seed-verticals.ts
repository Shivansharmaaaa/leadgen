import { eq } from "drizzle-orm";
import { db, tenants, locations, staff, knowledgeFacts, type TenantSettings } from "@/server/db";
import { NORTHSIDE_VOICE } from "./northside-voice";

/**
 * Demo businesses beyond HVAC, so the agent is tried on more than one trade.
 * Fictional: example.com-style addresses, staff with no phone numbers (alerts
 * cannot text anyone). Re-runnable: each tenant is replaced, and northside-hvac
 * only gains the per-tenant voice settings that used to be hardcoded.
 *
 *   npx tsx --env-file=.env scripts/seed-verticals.ts
 */

type Hours = { day: number; open: string; close: string }[];
type Vertical = {
  slug: string; name: string; country: string; timezone: string; vertical: string;
  settings: TenantSettings;
  location: { name: string; addressLine1: string; city: string; region: string; postalCode: string; phone: string; hours: Hours; serviceArea: string[] };
  owner: { name: string; email: string };
  facts: { category: string; key: string; value: string }[];
};

const weekdays = (open: string, close: string, sat?: [string, string]): Hours => [
  ...[1, 2, 3, 4, 5].map((day) => ({ day, open, close })),
  ...(sat ? [{ day: 6, open: sat[0], close: sat[1] }] : []),
];

const VERTICALS: Vertical[] = [
  {
    slug: "maple-immigration",
    name: "Maple Immigration Services",
    country: "CA",
    timezone: "America/Toronto",
    vertical: "professional_services",
    settings: {
      businessName: "Maple Immigration Services",
      agentName: "Maya",
      tone: "warm",
      priceFloor: 0,
      priceCeiling: 6000,
      currency: "CAD",
      autoSendThreshold: 0.75,
      // Someone facing removal needs a person now; a refusal or a lawyer
      // question is a consultant's call, not the assistant's.
      escalationTriggers: ["removal order", "deportation", "detained", "border hold", "refused entry"],
      asrContext: "this is an immigration consultancy: 'PR' is permanent residency, 'IRCC' is the immigration " +
        "department, and 'Express Entry', 'CRS score', 'PGWP', 'LMIA' and 'study permit' are program names " +
        "('express century' is 'Express Entry', 'PG WP' is 'PGWP')",
      bookingNoun: "consultation with a licensed consultant",
      outboundReasons: {
        express_entry: "applying for permanent residency through Express Entry",
        study_permit: "a study permit for Canada",
        work_permit: "a Canadian work permit",
        sponsorship: "sponsoring a family member to come to Canada",
      },
      domainTerms: [
        "visa", "permit", "study permit", "work permit", "express entry", "pr", "permanent residency",
        "citizenship", "sponsorship", "sponsor", "ircc", "crs", "pgwp", "lmia", "immigration", "refusal",
      ],
    },
    location: {
      name: "Maple Immigration — Toronto", addressLine1: "200 Bay St, Suite 1400", city: "Toronto",
      region: "ON", postalCode: "M5J 2J2", phone: "+14165550190",
      hours: weekdays("09:00", "18:00", ["10:00", "14:00"]),
      serviceArea: ["Toronto", "Mississauga", "Brampton", "Markham", "online across Canada"],
    },
    owner: { name: "Priya Raman", email: "owner@mapleimmigration.example" },
    facts: [
      { category: "services", key: "Offered", value: "Express Entry permanent residency, study permits, post-graduation work permits (PGWP), LMIA-based and open work permits, spousal and family sponsorship, visitor visas, citizenship applications" },
      { category: "services", key: "Not offered", value: "criminal defence, appeals before the Federal Court, and immigration to countries other than Canada" },
      { category: "pricing", key: "Consultation", value: "$150 for a 45-minute consultation with a licensed consultant, credited in full if you go on to retain us" },
      { category: "pricing", key: "Express Entry application", value: "from $2,500 professional fee, government fees extra" },
      { category: "pricing", key: "Study permit application", value: "from $1,200 professional fee, government fees extra" },
      { category: "pricing", key: "Spousal sponsorship", value: "from $3,500 professional fee, government fees extra" },
      { category: "policy", key: "Who advises", value: "Every case is handled by a Regulated Canadian Immigration Consultant (RCIC) licensed by the College of Immigration and Citizenship Consultants. The assistant gives general information only." },
      { category: "policy", key: "Outcomes", value: "No one can guarantee an approval; decisions are made by IRCC. We assess your chances honestly in the consultation." },
      { category: "policy", key: "Payment", value: "Card or e-transfer. Professional fees can be paid in up to three instalments." },
      { category: "policy", key: "Languages", value: "Consultations in English, Hindi, Punjabi, Tamil and French" },
      { category: "products", key: "How it works", value: "a consultation first, where a licensed consultant reviews your situation and tells you which programs fit; then a written quote; we only start once you retain us" },
    ],
  },
  {
    slug: "brightpath-admissions",
    name: "BrightPath Admissions",
    country: "GB",
    timezone: "Europe/London",
    vertical: "education",
    settings: {
      businessName: "BrightPath Admissions",
      agentName: "Sam",
      tone: "warm",
      priceFloor: 0,
      priceCeiling: 3000,
      currency: "GBP",
      autoSendThreshold: 0.75,
      escalationTriggers: ["safeguarding", "visa refused"],
      asrContext: "this is a university admissions counselling service: 'UCAS' is the UK application system, " +
        "'Oxbridge' means Oxford and Cambridge, 'personal statement' and 'predicted grades' are application terms " +
        "('you cast' is 'UCAS', 'ox bridge' is 'Oxbridge')",
      bookingNoun: "free 30-minute counselling session",
      outboundReasons: {
        undergrad: "applying to UK universities for undergraduate study",
        postgrad: "a master's application",
        personal_statement: "help with your personal statement",
        interview: "interview coaching for Oxbridge or medicine",
      },
      domainTerms: [
        "university", "uni", "ucas", "oxbridge", "oxford", "cambridge", "personal statement", "application",
        "admission", "admissions", "course", "degree", "masters", "master's", "undergraduate", "interview",
        "scholarship", "offer", "predicted grades",
      ],
    },
    location: {
      name: "BrightPath — London", addressLine1: "18 Bedford Row", city: "London",
      region: "Greater London", postalCode: "WC1R 4EJ", phone: "+442075550144",
      hours: weekdays("09:00", "19:00", ["10:00", "16:00"]),
      serviceArea: ["London", "online across the UK and internationally"],
    },
    owner: { name: "James Okafor", email: "owner@brightpath.example" },
    facts: [
      { category: "services", key: "Offered", value: "university shortlisting, UCAS undergraduate applications, master's applications, personal statement coaching, Oxbridge and medicine interview coaching, scholarship search" },
      { category: "services", key: "Not offered", value: "writing personal statements for students, visa applications, and tutoring for A-level exams" },
      { category: "pricing", key: "Counselling session", value: "the first 30-minute counselling session is free" },
      { category: "pricing", key: "Undergraduate application package", value: "£1,450: shortlist of five universities, personal statement coaching, application review and one mock interview" },
      { category: "pricing", key: "Master's application package", value: "£1,250 for up to four programmes, including statement and CV review" },
      { category: "pricing", key: "Personal statement review", value: "£180 for two rounds of written feedback" },
      { category: "pricing", key: "Interview coaching", value: "£95 per hour, or £340 for a block of four" },
      { category: "policy", key: "Outcomes", value: "We never guarantee an offer: universities decide. We help students make the strongest application they can." },
      { category: "policy", key: "Integrity", value: "Students write their own personal statements; we coach, we never write them." },
      { category: "policy", key: "Payment", value: "Card or bank transfer; packages can be split into three monthly payments" },
      { category: "products", key: "How it works", value: "a free 30-minute counselling session first to understand goals and grades, then a recommended package with a written price; nothing is charged until the student chooses one" },
    ],
  },
];

async function main() {
  for (const v of VERTICALS) {
    await db.delete(tenants).where(eq(tenants.slug, v.slug));
    const [tenant] = await db.insert(tenants).values({
      name: v.name, slug: v.slug, country: v.country, timezone: v.timezone,
      vertical: v.vertical, plan: "voice", settings: v.settings,
    }).returning();
    await db.insert(locations).values({
      tenantId: tenant.id, country: v.country, timezone: v.timezone, ...v.location,
    });
    await db.insert(staff).values({ tenantId: tenant.id, email: v.owner.email, name: v.owner.name, role: "owner" });
    await db.insert(knowledgeFacts).values(v.facts.map((f) => ({ tenantId: tenant.id, ...f })));
    console.log(`✓ ${v.slug}: ${v.facts.length} facts`);
  }

  const northside = await db.query.tenants.findFirst({ where: eq(tenants.slug, "northside-hvac") });
  if (northside) {
    await db.update(tenants)
      .set({ settings: { ...(northside.settings ?? {}), ...NORTHSIDE_VOICE } })
      .where(eq(tenants.id, northside.id));
    console.log("✓ northside-hvac: voice settings moved into the tenant");
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
