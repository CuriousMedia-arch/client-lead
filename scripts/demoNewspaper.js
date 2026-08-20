/**
 * Fills the Newspaper with sample releases so the year → month → day
 * drill-down can be tried before real leads have aged out.
 *
 *   node scripts/demoNewspaper.js          add samples
 *   node scripts/demoNewspaper.js --clear  remove them again
 *
 * Every company it creates is named with a marker so --clear can find them,
 * and nothing it touches affects your imported contacts.
 */
require("dotenv").config();
const db = require("../db");

const MARK = "[demo]";

// Spread across two years and several months, so every level of the
// drill-down has something to open.
const SAMPLES = [
  ["Zepto", "2026-08-14", "Zepto raises $350 Mn Series G led by Avenir"],
  ["Swiggy", "2026-08-14", "Swiggy Instamart opens 40 dark stores in tier-2 cities"],
  ["boAt", "2026-08-09", "boAt signs cricketer as brand ambassador for festive line"],
  ["Lenskart", "2026-08-02", "Lenskart appoints new Chief Marketing Officer"],
  ["Mamaearth", "2026-07-27", "Mamaearth unveils rebrand ahead of festive quarter"],
  ["Zomato", "2026-07-15", "Zomato reports quarterly profit, revenue up 32%"],
  ["Nykaa", "2026-06-30", "Nykaa opens 50th flagship store in Bengaluru"],
  ["CRED", "2026-06-11", "CRED faces backlash over new ad campaign"],
  ["Ola Electric", "2026-05-21", "Ola Electric launches new scooter range"],
  ["Licious", "2025-12-18", "Licious closes $150 Mn round to fund expansion"],
  ["Sugar Cosmetics", "2025-11-05", "Sugar Cosmetics enters 100 new retail doors"],
  ["Blinkit", "2025-09-23", "Blinkit names new Head of Brand Marketing"],
];

(async () => {
  const clearing = process.argv.includes("--clear");

  if (clearing) {
    const { rowCount } = await db.pool.query("DELETE FROM companies WHERE name LIKE $1", [
      `%${MARK}`,
    ]);
    console.log(`\n  Removed ${rowCount} sample compan${rowCount === 1 ? "y" : "ies"}.\n`);
    await db.pool.end();
    return;
  }

  let added = 0;

  for (const [name, date, headline] of SAMPLES) {
    const display = `${name} ${MARK}`;

    const company = await db.one(
      `INSERT INTO companies (name, keywords, active, origin, approval, industry)
       VALUES ($1, $2::jsonb, false, 'discovered', 'approved', 'Sample data')
       ON CONFLICT (lower(name)) DO UPDATE SET name = companies.name
       RETURNING id`,
      [display, JSON.stringify([name])]
    );

    const lead = await db.one(
      `INSERT INTO leads (company_id) VALUES ($1)
       ON CONFLICT (company_id) DO UPDATE SET company_id = EXCLUDED.company_id
       RETURNING id`,
      [company.id]
    );

    // Park it in the Newspaper, dated — that's what the drill-down groups on.
    await db.run(
      `UPDATE leads
          SET in_newspaper = true,
              fresh_owner_id = NULL,
              fresh_deadline_at = NULL,
              fresh_released_at = $1::timestamptz,
              released_at = $1::timestamptz,
              last_signal_at = $1::timestamptz,
              status = 'new'
        WHERE id = $2`,
      [`${date} 10:00:00+05:30`, lead.id]
    );

    await db.run(
      `INSERT INTO signals (lead_id, company, title, url, site, published, signal_type, summary)
       VALUES ($1,$2,$3,$4,'afaqs',$5::timestamptz,'capital',$6)
       ON CONFLICT (url) DO NOTHING`,
      [
        lead.id,
        display,
        headline,
        `https://sample.local/${lead.id}`,
        `${date} 09:00:00+05:30`,
        "Sample entry, added so the Newspaper can be tried before real leads age out.",
      ]
    );

    added++;
  }

  const years = [...new Set(SAMPLES.map((s) => s[1].slice(0, 4)))].sort().reverse();

  console.log(`\n  Added ${added} sample releases to the Newspaper.`);
  console.log(`  Years to explore: ${years.join(", ")}`);
  console.log(`  Every sample company is tagged "${MARK}".`);
  console.log(`  Remove them with:  node scripts/demoNewspaper.js --clear\n`);

  await db.pool.end();
})().catch(async (err) => {
  console.error("\n  Failed:", err.message, "\n");
  await db.pool.end().catch(() => {});
  process.exit(1);
});
