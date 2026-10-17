import { extractIdentifiers, extractName } from "@/server/core/extract";

/**
 * Deterministic identifier harvesting: a name or number taken from what the
 * caller said, before the turn, so booking can be offered on time and never
 * under the wrong name.
 *
 *   npm run extract:test
 */
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}
const is = (text: string, want: string | null) => {
  const got = extractName(text);
  check(`${JSON.stringify(text)} → ${want ?? "no name"}`, got === want, String(got));
};

console.log("\nNames stated outright");
is("My name's Dana Reyes.", "Dana Reyes");
is("my name is dana", "Dana");
is("I'm Arjun Mehta.", "Arjun Mehta");
is("this is Priya", "Priya");
is("It's Jordan from Quincy", "Jordan");
is("My name's Dana and my number is 617 555 0134", "Dana");
is("Hi, I'm Brian, my furnace is out", "Brian");
is("I'm Julian Okafor", "Julian Okafor");

is("Yes. It's Harpreet, h a r p r e e t Sandhu, s a n d h u.", "Harpreet Sandhu");
is("Yes, it will be under Grace Adeyemi.", "Grace Adeyemi");
is("Put it under Sam Carter please", "Sam Carter");
is("Under the name of Leila Ahmadi.", "Leila Ahmadi");
is("Put it under my wife's name", null);
is("I'm a nurse, I work nights", null);

console.log("\nNot names");
is("It's Tuesday at 10 that works", null);
is("It is Saturday morning I want", null);
is("It's tomorrow I need it", null);
is("I'm Canadian, on a work permit", null);
is("I'm British but I live in Dubai", null);
is("I'm Indian, applying for a study permit", null);
is("This is Express Entry stuff", null);
is("I'm calling about my AC", null);
is("I'm International, applying for a master's", null);

console.log("\nA bare name, only as the answer to a name question");
const asked = (text: string, last: string, want: string | null) => {
  const got = extractName(text, { lastAgentLine: last });
  check(`${JSON.stringify(text)} after ${JSON.stringify(last)} → ${want ?? "no name"}`, got === want, String(got));
};
asked("Grace Fontaine.", "Great. Can I get your name?", "Grace Fontaine");
asked("grace fontaine", "Perfect. What name should I put it under?", "Grace Fontaine");
asked("Yeah, it's Grace.", "And your name, please?", "Grace");
asked("Tori, t o r i.", "Can I get your name for the booking?", "Tori");
asked("Saturday at nine", "Can I get your name?", null);
asked("The first one.", "Can I get your name?", null);
asked("Yes.", "Can I get your name?", null);
asked("Nine thirty.", "What name should I put it under?", null);
asked("Grace Fontaine.", "Which time works better for you?", null);
asked("I want a refund for my visit", "Can I get your name?", null);
is("Grace Fontaine.", null);

// Real answers to a name question, from Taskmaster-1 (CC BY 4.0, train split; see finetune/README.md).
// Measured over all 258 bank lines: 250 exact, none wrong; 45 of 48 held-out lines exact, none wrong.
const ASKED = "Can I get your name for the booking?";
asked("Mike Jones 281-330-8004.", ASKED, "Mike Jones");
asked("Of course. Lola Smith.", ASKED, "Lola Smith");
asked("John Smith. It's 689-155-1234.", ASKED, "John Smith");
asked("No, it's Burt b u r t and my last name is Real r e a l.", ASKED, "Burt Real");
asked("My first name is Billy. My last name is Beane. b e a n e.", ASKED, "Billy Beane");
asked("Chester parrot Chester parrot, p a r r o t.", ASKED, "Chester Parrot");
asked("Larry Larry Phillips.", ASKED, "Larry Phillips");
asked("Sure, Tori t o r i Childs c h i l d s. Yes, 215-884-1482.", ASKED, "Tori Childs");
is("Mike Jones 281-330-8004.", null);

console.log("\nNumbers");
const us = extractIdentifiers("call me on 617 555 0134", "US").phones;
check("a spoken US number is normalised", us.length === 1 && us[0] === "+16175550134", us.join(","));
const uk = extractIdentifiers("my mobile is 07700 900123", "GB").phones;
check("a UK mobile is normalised", uk.length === 1 && uk[0] === "+447700900123", uk.join(","));

console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
process.exit(failures ? 1 : 0);
