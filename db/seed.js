require("dotenv").config();

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const db = require("./index");
const { hashPassword } = require("../lib/auth");

// Carried over from the original config/ folder so nothing is lost in the move.
const SITES = [
  { name: "ottplay", domain: "ottplay.com" },
  { name: "hindustan-times", domain: "hindustantimes.com" },
  { name: "livemint", domain: "livemint.com" },
  { name: "business-today", domain: "businesstoday.in" },
  { name: "business-standard", domain: "business-standard.com" },
  { name: "economic-times", domain: "economictimes.indiatimes.com" },
  { name: "entrackr", domain: "entrackr.com" },
  { name: "yourstory", domain: "yourstory.com" },
  { name: "india-today", domain: "indiatoday.in" },
  { name: "espn", domain: "espn.in" },
  { name: "inc42", domain: "inc42.com" },
  { name: "filmibeat", domain: "filmibeat.com" },
  { name: "bollywood-hungama", domain: "bollywoodhungama.com" },

  // Trade press from the PFA playbook — where the real buying signals appear.
  { name: "afaqs", domain: "afaqs.com" },
  { name: "exchange4media", domain: "exchange4media.com" },
  { name: "storyboard18", domain: "storyboard18.com" },
  { name: "campaign-india", domain: "campaignindia.in" },
  { name: "brand-equity", domain: "brandequity.economictimes.indiatimes.com" },
  { name: "vccircle", domain: "vccircle.com" },
  { name: "techcrunch", domain: "techcrunch.com" },
  { name: "retail4growth", domain: "retail4growth.com" },
  { name: "indiaretailing", domain: "indiaretailing.com" },
  { name: "indian-retailer", domain: "indianretailer.com" },
];

const COMPANIES = [
  { name: "POPxo", keywords: ["POPxo"] },
  { name: "Meesho", keywords: ["Meesho"] },
  { name: "TATA.ev", keywords: ["TATA.ev", "Tata EV"] },
  { name: "Bluedart", keywords: ["Bluedart", "Blue Dart"] },
  { name: "ZEE Business", keywords: ["ZEE Business"] },
  { name: "META", keywords: ["Meta Platforms", "META CEO"] },
  { name: "Essar Group", keywords: ["Essar Group"] },
];

// Off by default - turning these on narrows results to business events only.
const TOPICS = [
  "funding", "raises", "IPO", "valuation", "investment", "series A", "series B",
  "appoints", "hires", "resigns", "steps down", "new CEO",
  "profit", "revenue", "earnings", "quarterly results",
  "launches", "unveils", "rolls out", "expands", "expansion",
  "acquires", "acquisition", "merger", "stake sale",
];

function ask(question, { silent = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (silent) {
      const onData = (char) => {
        if (["\n", "\r", "\u0004"].includes(char.toString())) process.stdin.pause();
        else {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
          process.stdout.write(question + "*".repeat(rl.line.length));
        }
      };
      process.stdin.on("data", onData);
      rl.question(question, (answer) => {
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        rl.close();
        resolve(answer.trim());
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

(async () => {
  console.log("\nCurious Media - Lead Intelligence setup\n");

  // --- schema ----------------------------------------------------------------
  // Every statement is idempotent, so this doubles as the migration step.
  const schema = fs.readFileSync(path.join(__dirname, "schema.postgres.sql"), "utf8");
  try {
    await db.pool.query(schema);
    console.log("Schema applied.");
  } catch (err) {
    console.error(`\nCouldn't apply the schema: ${err.message}`);
    console.error("Check DATABASE_URL, or paste db/schema.postgres.sql into the Supabase SQL editor.\n");
    process.exit(1);
  }

  // --- watchlist -------------------------------------------------------------
  await db.tx(async (q) => {
    for (const s of SITES) {
      await q("INSERT INTO sites (name, domain) VALUES ($1, $2) ON CONFLICT (domain) DO NOTHING", [
        s.name,
        s.domain,
      ]);
    }
    for (const c of COMPANIES) {
      await q(
        "INSERT INTO companies (name, keywords) VALUES ($1, $2::jsonb) ON CONFLICT (name) DO NOTHING",
        [c.name, JSON.stringify(c.keywords)]
      );
    }
    for (const t of TOPICS) {
      await q("INSERT INTO topics (keyword, active) VALUES ($1, false) ON CONFLICT (keyword) DO NOTHING", [t]);
    }
  });

  await db.run(
    "INSERT INTO leads (company_id) SELECT id FROM companies ON CONFLICT (company_id) DO NOTHING"
  );

  const counts = await db.one(
    `SELECT (SELECT COUNT(*) FROM companies) AS companies,
            (SELECT COUNT(*) FROM sites) AS sites,
            (SELECT COUNT(*) FROM topics) AS topics`
  );
  console.log(
    `Watchlist ready: ${counts.companies} companies, ${counts.sites} sources, ` +
      `${counts.topics} topic keywords (off by default).`
  );

  // --- admin account ---------------------------------------------------------
  const adminCount = await db.value("SELECT COUNT(*) n FROM users WHERE role = 'admin'");
  if (adminCount > 0) {
    console.log(`\n${adminCount} admin account(s) already exist. Nothing else to do.`);
    console.log("Start the app with:  npm start\n");
    await db.pool.end();
    process.exit(0);
  }

  console.log("\nCreate the first admin account.\n");

  // Env vars let you seed without the prompts (handy in a script or if the
  // hidden-password prompt misbehaves in your terminal):
  //   ADMIN_USERNAME=you@curiousmedia.in ADMIN_PASSWORD=secret npm run setup
  const envUser = process.env.ADMIN_USERNAME;
  const envPass = process.env.ADMIN_PASSWORD;

  let username, displayName, password;

  if (envUser && envPass) {
    if (envPass.length < 6) {
      console.error("ADMIN_PASSWORD needs at least 6 characters.\n");
      process.exit(1);
    }
    username = envUser;
    displayName = process.env.ADMIN_NAME || envUser;
    password = envPass;
    console.log(`Using ADMIN_USERNAME / ADMIN_PASSWORD from the environment.`);
  } else {
    username = (await ask("Username: ")) || "admin";
    displayName = (await ask("Display name: ")) || username;
    password = "";
    while (password.length < 6) {
      password = await ask("Password (min 6 chars): ", { silent: true });
      if (password.length < 6) console.log("Too short, try again.");
    }
  }

  await db.run(
    "INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $2, $3, 'admin')",
    [username.toLowerCase(), displayName, hashPassword(password)]
  );

  console.log(`\nAdmin "${username}" created.`);
  console.log("Start the app with:  npm start");
  console.log("Then open http://localhost:3000 and add the rest of your team from the Admin tab.\n");
  await db.pool.end();
  process.exit(0);
})();
