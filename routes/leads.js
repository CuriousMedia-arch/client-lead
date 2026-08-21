const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");
const playbook = require("../lib/triggers");
const lifecycle = require("../lib/lifecycle");

const router = express.Router();
router.use(requireAuth);

const STATUSES = ["new", "working", "contacted", "replied", "qualified", "won", "lost"];
const OPEN_STATUSES = ["working", "contacted", "replied", "qualified"];
const CONTACT_KINDS = ["email", "call", "linkedin", "meeting"];

// How recent a signal must be to put a company in Fresh Leads.
const FRESH_DAYS = Number(process.env.FRESH_WINDOW_DAYS || 3);

const list = (v) =>
  String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Which half of Fresh Leads is being asked for. Anything else is "company". */
const freshKind = (params) => (params && params.freshKind === "new" ? "new" : "company");

/**
 * The four views are all the same query with a different WHERE.
 *
 *   all       - the contact database. Every company, no signals shown.
 *   fresh     - companies from that database with news in the last few days.
 *   mine      - what this user has claimed, with its countdown.
 *   newspaper - the parking lot: Fresh claims that ran out of time.
 */
async function queryLeads(params, user) {
  const tab = params.tab || "all";
  const where = [];
  const args = [];
  const bind = (v) => `$${args.push(v)}`;

  if (tab === "fresh") {
    // Unclaimed on the FRESH track specifically. Whether someone claimed this
    // company from All Leads is irrelevant here — that's a different claim.
    where.push("l.fresh_owner_id IS NULL");
    where.push("l.in_newspaper = false");
    where.push("c.is_sample = false");

    // Fresh Leads is two lists, not one.
    //
    //   company - news about companies that are already in All Leads. The
    //             watchlist sweep finds these, every 3 days.
    //   new     - companies the discovery sweep turned up that are NOT in All
    //             Leads. They run daily, they're claimable here, and they stay
    //             out of All Leads until an admin approves them.
    where.push(
      freshKind(params) === "new" ? "c.approval = 'pending'" : "c.approval = 'approved'"
    );

    where.push(
      `EXISTS (SELECT 1 FROM signals s WHERE s.lead_id = l.id
                AND COALESCE(s.published, s.created_at) >= now() - interval '${FRESH_DAYS} days')`
    );
  } else if (tab === "mine") {
    // Owned on either track — the two lists get split apart client-side.
    where.push(`(l.owner_id = ${bind(user.id)} OR l.fresh_owner_id = ${bind(user.id)})`);
  } else if (tab === "newspaper") {
    where.push("l.in_newspaper = true");
  } else {
    // All Leads is the real database. Sample rows exist only to demonstrate the
    // Newspaper and have no place in it.
    where.push("c.is_sample = false");
    // Nor do companies the discovery sweep found on its own. Those sit in
    // Fresh Leads > New Leads and only cross over once an admin approves
    // them — a name Gemini read off an article isn't the contact database.
    where.push("c.approval = 'approved'");
  }
  // "all" has no filter: every company on the watchlist, regardless of
  // whether it also happens to be claimed, fresh, or sitting in the
  // Newspaper on its Fresh track — those are independent of the database.

  const types = list(params.types);
  if (types.length) {
    where.push(
      `EXISTS (SELECT 1 FROM signals s WHERE s.lead_id = l.id
                AND s.signal_type = ANY(${bind(types)}))`
    );
  }

  const statuses = list(params.status).filter((s) => STATUSES.includes(s));
  if (statuses.length) where.push(`l.status = ANY(${bind(statuses)})`);

  if (params.q) {
    const q = bind(`%${String(params.q).toLowerCase()}%`);
    where.push(`(LOWER(c.name) LIKE ${q} OR LOWER(COALESCE(c.industry,'')) LIKE ${q})`);
  }

  if (params.tier) {
    // Tier is derived from the trigger, so filter on the trigger types it covers.
    const ids = playbook.SEGMENTS.filter((s) => String(s.tier) === String(params.tier)).map(
      (s) => s.id
    );
    if (ids.length) {
      where.push(
        `EXISTS (SELECT 1 FROM signals s WHERE s.lead_id = l.id AND s.signal_type = ANY(${bind(ids)}))`
      );
    }
  }

  const sortMap = {
    urgent:
      "LEAST(COALESCE(l.deadline_at, 'infinity'), COALESCE(l.fresh_deadline_at, 'infinity')) ASC, LOWER(c.name) ASC",
    recent: "l.last_signal_at DESC NULLS LAST, LOWER(c.name) ASC",
    company: "LOWER(c.name) ASC",
    added: "c.created_at DESC, LOWER(c.name) ASC",
    released: "COALESCE(l.released_at, l.last_signal_at, l.updated_at) DESC, LOWER(c.name) ASC",
  };
  // The Newspaper is browsed by date, so it always comes back newest first —
  // the frontend buckets it into year, month and day from there.
  const orderBy =
    tab === "newspaper"
      ? sortMap.released
      : sortMap[params.sort] || (tab === "mine" ? sortMap.urgent : sortMap.company);

  const leads = await db.all(
    `SELECT l.id, l.status, l.owner_id,
            l.claimed_at, l.claim_source, l.deadline_at, l.closed_at, l.release_note,
            l.fresh_owner_id, l.fresh_claimed_at, l.fresh_deadline_at, l.fresh_closed_at,
            l.in_newspaper, l.fresh_from_newspaper, l.fresh_release_note,
            l.contact_name, l.contact_role, l.contact_email, l.contact_phone,
            l.last_contacted_at, l.next_followup_at, l.last_signal_at,
            c.name AS company, c.id AS company_id,
            c.domain, c.website, c.linkedin, c.industry, c.employees, c.revenue,
            c.founded, c.city, c.state, c.created_at AS added_at,
            -- The day the FRESH claim landed in the Newspaper — independent
            -- of anything happening on the All Leads claim for this company.
            -- Rows released before the column existed fall back to their
            -- last news, then to updated_at, so nothing turns up "Undated".
            COALESCE(l.fresh_released_at, l.last_signal_at, l.updated_at) AS newspaper_date,
            u.display_name AS owner_name,
            fu.display_name AS fresh_owner_name,
c.is_sample
       FROM leads l
       JOIN companies c ON c.id = l.company_id
       LEFT JOIN users u  ON u.id = l.owner_id
       LEFT JOIN users fu ON fu.id = l.fresh_owner_id
      ${where.length ? "WHERE " + where.join("\n        AND ") : ""}
      ORDER BY ${orderBy}
      LIMIT ${bind(Math.min(Number(params.limit) || 50, 200))}
      OFFSET ${bind(Math.max(Number(params.offset) || 0, 0))}`,
    args
  );

  if (!leads.length) return leads;

  // Counts for the returned page only, in a single round trip. These used to be
  // three correlated subqueries per row — 1,200 of them on a 400-row page.
  await attachCounts(leads);

  // All Leads is a database view — no signals, no pitch. Everywhere else gets
  // the news that justifies the lead.
  //
  // Fresh Leads is the exception that needs a second limit: a company qualifies
  // on having news in the last few days, but without this it would then be
  // shown its whole back catalogue, so a lead with one item from today read as
  // though it had eight. Fresh only ever shows what's inside the window.
  if (tab !== "all") await attachSignals(leads, tab === "fresh" ? FRESH_DAYS : null);

  for (const lead of leads) {
    // Two independent clocks — claiming one track never starts the other's.
    lead.countdown = lifecycle.countdown(lead.deadline_at, lead.closed_at);
    lead.claim_window = lead.owner_id ? lifecycle.windowFor("all") : null;
    lead.fresh_countdown = lifecycle.countdown(lead.fresh_deadline_at, lead.fresh_closed_at);
    lead.fresh_claim_window = lead.fresh_owner_id ? lifecycle.windowFor("fresh") : null;
  }

  return leads;
}

/**
 * Recent signals per lead, newest first, plus the tier they imply.
 *
 * `maxAgeDays` caps how far back the news may reach. Number() rather than a
 * bind parameter because it sits inside an interval literal, and it keeps a
 * value straight off the query string out of the SQL.
 */
/**
 * Signal and contact counts for a page of leads.
 *
 * Two grouped queries over an indexed id list, rather than a correlated
 * subquery per row. At 1,500 companies that was 4,500 subqueries a page load;
 * this is two.
 */
async function attachCounts(leads) {
  const ids = leads.map((l) => l.id);
  const names = leads.map((l) => String(l.company).toLowerCase());

  const [signalRows, contactRows] = await Promise.all([
    db.all(
      `SELECT lead_id,
              COUNT(*)::int AS signal_count,
              COUNT(*) FILTER (
                WHERE COALESCE(published, created_at) >= now() - interval '${FRESH_DAYS} days'
              )::int AS fresh_count
         FROM signals
        WHERE lead_id = ANY($1)
        GROUP BY lead_id`,
      [ids]
    ),
    db.all(
      `SELECT lower(company) AS key, COUNT(*)::int AS contact_count
         FROM company_contacts
        WHERE lower(company) = ANY($1) AND deleted_at IS NULL
        GROUP BY lower(company)`,
      [names]
    ),
  ]);

  const bySignal = new Map(signalRows.map((r) => [r.lead_id, r]));
  const byContact = new Map(contactRows.map((r) => [r.key, r.contact_count]));

  for (const lead of leads) {
    const sg = bySignal.get(lead.id);
    lead.signal_count = sg ? sg.signal_count : 0;
    lead.fresh_count = sg ? sg.fresh_count : 0;
    lead.contact_count = byContact.get(String(lead.company).toLowerCase()) || 0;
  }
}

async function attachSignals(leads, maxAgeDays = null) {
  const window = Number(maxAgeDays);
  const ageFilter =
    Number.isFinite(window) && window > 0
      ? `AND COALESCE(s.published, s.created_at) >= now() - interval '${window} days'`
      : "";

  const rows = await db.all(
    `SELECT * FROM (
       SELECT s.id, s.lead_id, s.title, s.url, s.site, s.published, s.created_at,
              s.signal_type, s.summary, s.why_it_matters, s.pitch,
              ROW_NUMBER() OVER (
                PARTITION BY s.lead_id
                ORDER BY COALESCE(s.published, s.created_at) DESC
              ) AS rn
         FROM signals s
        WHERE s.lead_id = ANY($1)
          ${ageFilter}
     ) t WHERE t.rn <= 8`,
    [leads.map((l) => l.id)]
  );

  const byLead = new Map();
  for (const s of rows) {
    if (!byLead.has(s.lead_id)) byLead.set(s.lead_id, []);
    byLead.get(s.lead_id).push(s);
  }

  for (const lead of leads) {
    const signals = byLead.get(lead.id) || [];
    lead.signals = signals;

    // The strongest trigger present decides the tier — no numeric score.
    const best = signals
      .slice()
      .sort((a, b) => playbook.tierOf(a.signal_type) - playbook.tierOf(b.signal_type))[0];

    const seg = playbook.segment(best && best.signal_type);
    lead.tier = seg.tier;
    lead.tier_label = playbook.TIERS[seg.tier].label;
    lead.tier_note = playbook.TIERS[seg.tier].note;
    lead.segment_label = seg.label;
    lead.angle = seg.angle;
    lead.next_action = seg.action;
    lead.pitch =
      (best && best.pitch && best.pitch.trim()) ||
      playbook.composePitch({
        company: lead.company,
        signalType: best && best.signal_type,
        headline: best && best.title,
        when: best ? timeAgo(best.published || best.created_at) : null,
        industry: lead.industry,
      });
    lead.pitch_is_tailored = Boolean(best && best.pitch && best.pitch.trim());
  }
}

router.get("/", async (req, res, next) => {
  try {
    // Always settle expired claims before answering, so nobody sees a lead as
    // owned when its clock ran out an hour ago.
    await lifecycle.sweepExpired();
    const leads = await queryLeads(req.query, req.user);
    // The client needs to know whether asking for more is worth a round trip.
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json({ leads, hasMore: leads.length === limit });
  } catch (err) {
    next(err);
  }
});

/** The people behind one company — All Leads expands into this. */
/**
 * The same thing for a whole page of leads at once.
 *
 * Fresh Leads used to ask for each card's contacts separately — twelve cards
 * meant twelve round trips before the page settled. This answers all of them
 * in one, which is the difference between a page that appears and a page that
 * fills in over several seconds.
 */
router.get("/people/batch", async (req, res, next) => {
  try {
    const ids = String(req.query.ids || "")
      .split(",")
      .map((n) => Number(n))
      .filter(Number.isFinite)
      .slice(0, 200);

    if (!ids.length) return res.json({ byLead: {} });

    const rows = await db.all(
      `SELECT l.id AS lead_id, cc.id, cc.name, cc.role, cc.email, cc.phone,
              cc.linkedin, cc.owner_id, cc.status, cc.claimed_at, cc.closed_at,
              cc.release_note, cc.verified, cc.verified_at, cc.claim_source,
              u.display_name AS owner_name
         FROM leads l
         JOIN companies c ON c.id = l.company_id
         JOIN company_contacts cc ON lower(cc.company) = lower(c.name)
                                 AND cc.deleted_at IS NULL
         LEFT JOIN users u ON u.id = cc.owner_id
        WHERE l.id = ANY($1)
        ORDER BY cc.owner_id IS NULL, LOWER(cc.name)`,
      [ids]
    );

    const contactIds = rows.map((r) => r.id);
    const logs = contactIds.length
      ? await db.all(
          `SELECT * FROM (
             SELECT a.contact_id, a.kind, a.body, a.created_at, u.display_name AS user_name,
                    ROW_NUMBER() OVER (PARTITION BY a.contact_id ORDER BY a.created_at DESC) AS rn
               FROM contact_activity a LEFT JOIN users u ON u.id = a.user_id
              WHERE a.contact_id = ANY($1)
           ) t WHERE t.rn <= 3`,
          [contactIds]
        )
      : [];

    const logsByContact = new Map();
    for (const l of logs) {
      if (!logsByContact.has(l.contact_id)) logsByContact.set(l.contact_id, []);
      logsByContact.get(l.contact_id).push(l);
    }

    const byLead = {};
    for (const r of rows) {
      if (!byLead[r.lead_id]) byLead[r.lead_id] = [];
      byLead[r.lead_id].push({ ...r, activity: logsByContact.get(r.id) || [] });
    }

    res.json({ byLead });
  } catch (err) {
    next(err);
  }
});

/**
 * Everyone at a company, with who holds each one and what they've logged.
 *
 * A Fresh Leads holder is working the company, so they need to see that a
 * colleague already has the CMO and what was said — otherwise two people ring
 * the same person in the same week.
 */
router.get("/:id/people", async (req, res, next) => {
  try {
    const lead = await db.one(
      `SELECT c.name FROM leads l JOIN companies c ON c.id = l.company_id WHERE l.id = $1`,
      [req.params.id]
    );
    if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

    const contacts = await db.all(
      `SELECT cc.*, u.display_name AS owner_name, vu.display_name AS verified_by_name
         FROM company_contacts cc
         LEFT JOIN users u  ON u.id  = cc.owner_id
         LEFT JOIN users vu ON vu.id = cc.verified_by
        WHERE lower(cc.company) = lower($1) AND cc.deleted_at IS NULL
        ORDER BY cc.owner_id IS NULL, LOWER(cc.name)`,
      [lead.name]
    );

    if (contacts.length) {
      const logs = await db.all(
        `SELECT a.contact_id, a.kind, a.body, a.stage, a.created_at, u.display_name AS user_name
           FROM contact_activity a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.contact_id = ANY($1)
          ORDER BY a.created_at DESC`,
        [contacts.map((c) => c.id)]
      );

      const byContact = new Map();
      for (const l of logs) {
        if (!byContact.has(l.contact_id)) byContact.set(l.contact_id, []);
        byContact.get(l.contact_id).push(l);
      }
      for (const c of contacts) c.activity = (byContact.get(c.id) || []).slice(0, 5);
    }

    res.json({ company: lead.name, contacts });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/contacts", async (req, res, next) => {
  try {
    const lead = await db.one(
      `SELECT c.name FROM leads l JOIN companies c ON c.id = l.company_id WHERE l.id = $1`,
      [req.params.id]
    );
    if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

    const contacts = await db.all(
      `SELECT id, name, role, email, phone, phone2, linkedin, seniority, department,
              city, state, country, verified, is_primary
         FROM company_contacts
        WHERE lower(company) = lower($1) AND deleted_at IS NULL
        ORDER BY is_primary DESC, name ASC`,
      [lead.name]
    );

    res.json({ contacts });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    await lifecycle.sweepExpired();

    const lead = await db.one(
      `SELECT l.*, c.name AS company, c.keywords,
              c.domain, c.website, c.linkedin, c.industry, c.employees, c.revenue,
              c.founded, c.city, c.state, c.created_at AS added_at,
              u.display_name AS owner_name, fu.display_name AS fresh_owner_name
         FROM leads l
         JOIN companies c ON c.id = l.company_id
         LEFT JOIN users u  ON u.id = l.owner_id
         LEFT JOIN users fu ON fu.id = l.fresh_owner_id
        WHERE l.id = $1`,
      [req.params.id]
    );

    if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

    const [signals, activity, contacts] = await Promise.all([
      db.all(
        `SELECT id, title, url, author, site, section_title, published, created_at,
                signal_type, summary, why_it_matters, pitch
           FROM signals WHERE lead_id = $1
          ORDER BY COALESCE(published, created_at) DESC`,
        [lead.id]
      ),
      db.all(
        `SELECT a.id, a.kind, a.body, a.created_at, u.display_name AS user_name
           FROM activity a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.lead_id = $1 ORDER BY a.created_at DESC`,
        [lead.id]
      ),
      db.all(
        `SELECT id, name, role, email, phone, phone2, linkedin, seniority, department,
                city, state, country, verified, is_primary
           FROM company_contacts WHERE lower(company) = lower($1)
          ORDER BY is_primary DESC, name ASC`,
        [lead.company]
      ),
    ]);

    lead.signals = signals;
    lead.activity = activity;
    lead.contacts = contacts;
    lead.countdown = lifecycle.countdown(lead.deadline_at, lead.closed_at);
    lead.claim_window = lead.owner_id ? lifecycle.windowFor("all") : null;
    lead.fresh_countdown = lifecycle.countdown(lead.fresh_deadline_at, lead.fresh_closed_at);
    lead.fresh_claim_window = lead.fresh_owner_id ? lifecycle.windowFor("fresh") : null;

    const best = signals
      .slice()
      .sort((a, b) => playbook.tierOf(a.signal_type) - playbook.tierOf(b.signal_type))[0];
    const seg = playbook.segment(best && best.signal_type);
    lead.tier = seg.tier;
    lead.tier_label = playbook.TIERS[seg.tier].label;
    lead.tier_note = playbook.TIERS[seg.tier].note;
    lead.segment_label = seg.label;
    lead.angle = seg.angle;
    lead.next_action = seg.action;
    lead.pitch =
      (best && best.pitch && best.pitch.trim()) ||
      playbook.composePitch({
        company: lead.company,
        signalType: best && best.signal_type,
        headline: best && best.title,
        when: best ? timeAgo(best.published || best.created_at) : null,
        industry: lead.industry,
      });
    lead.pitch_is_tailored = Boolean(best && best.pitch && best.pitch.trim());

    res.json({ lead });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const lead = await db.one("SELECT * FROM leads WHERE id = $1", [req.params.id]);
    if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

    const b = req.body || {};
    const sets = [];
    const args = [];
    const bind = (v) => `$${args.push(v)}`;

    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status))
        return res.status(400).json({ error: `Unknown status "${b.status}".` });
      sets.push(`status = ${bind(b.status)}`);
    }

    if (b.owner_id !== undefined) {
      sets.push(`owner_id = ${bind(b.owner_id === null || b.owner_id === "" ? null : Number(b.owner_id))}`);
    }

    for (const key of ["contact_name", "contact_role", "contact_email", "contact_phone"]) {
      if (b[key] !== undefined) sets.push(`${key} = ${bind(b[key] ? String(b[key]).trim() : null)}`);
    }

    if (b.next_followup_at !== undefined)
      sets.push(`next_followup_at = ${bind(b.next_followup_at || null)}`);

    if (!sets.length) return res.json({ lead });

    const updated = await db.one(
      `UPDATE leads SET ${sets.join(", ")}, updated_at = now()
        WHERE id = ${bind(lead.id)} RETURNING *`,
      args
    );

    if (b.status && b.status !== lead.status) {
      await logActivity(lead.id, req.user.id, "status", `Moved from ${lead.status} to ${b.status}`);
    }

    updated.countdown = lifecycle.countdown(updated.deadline_at, updated.closed_at);
    updated.fresh_countdown = lifecycle.countdown(updated.fresh_deadline_at, updated.fresh_closed_at);
    res.json({ lead: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * Claim, on one track. `source` decides the deadline (10 days from Fresh,
 * 30 from All) AND which track gets touched — claiming from All Leads never
 * grants the Fresh Lead on the same company, and claiming from Fresh Leads
 * never grants the All Leads relationship. They're checked and written
 * independently. Once someone owns a track, nobody else can take it over on
 * that track — only that owner (by releasing or closing it) or the deadline
 * sweep frees it back up. The other track is unaffected either way. */
router.post("/:id/claim", async (req, res, next) => {
  try {
    const lead = await db.one(
      `SELECT l.*, u.display_name AS owner_name, fu.display_name AS fresh_owner_name
         FROM leads l
         LEFT JOIN users u  ON u.id = l.owner_id
         LEFT JOIN users fu ON fu.id = l.fresh_owner_id
        WHERE l.id = $1`,
      [req.params.id]
    );
    if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

    const raw = req.body && req.body.source;
    const source = raw === "fresh" || raw === "newspaper" || raw === "all" ? raw : "all";
    const ownerId = source === "fresh" ? lead.fresh_owner_id : lead.owner_id;
    const ownerName = source === "fresh" ? lead.fresh_owner_name : lead.owner_name;

    if (req.body && req.body.release) {
      if (ownerId && ownerId !== req.user.id) {
        return res.status(403).json({ error: "Only the owner can release this lead." });
      }

      // Same rule as releasing a contact: whoever picks this up next needs to
      // know why it was handed back, not just that it was.
      const note = String((req.body && req.body.note) || "").trim();
      if (note.length < 3) {
        return res.status(400).json({
          error: "Say why you're releasing it, so whoever picks it up knows where things stand.",
        });
      }

      const released = await lifecycle.release(lead.id, source);
      await db.run(
        `UPDATE leads SET ${source === "fresh" ? "fresh_release_note" : "release_note"} = $1
          WHERE id = $2`,
        [note, lead.id]
      );
      released[source === "fresh" ? "fresh_release_note" : "release_note"] = note;

      await logActivity(
        lead.id,
        req.user.id,
        "claim",
        `Released ${source === "fresh" ? "Fresh Leads" : "All Leads"} claim — ${note}`
      );
      if (source === "fresh") released.fresh_countdown = null;
      else released.countdown = null;
      return res.json({ lead: released });
    }

    if (ownerId && ownerId !== req.user.id) {
      return res
        .status(409)
        .json({ error: `Already claimed by ${ownerName || "someone else"} — it's locked to them.` });
    }

    const claimed = await lifecycle.claim(lead.id, req.user.id, source);

    await logActivity(
      lead.id,
      req.user.id,
      "claim",
      `Claimed from ${source === "fresh" ? "Fresh Leads" : "All Leads"} — ${lifecycle.windowFor(
        source
      )} days to close`
    );

    // Claiming the company takes its people with it. Only on the Fresh track:
    // an All Leads claim is a claim on one person, and always has been.
    if (source !== "all") {
      const cascade = await lifecycle.cascadeFreshClaim(lead.id, req.user.id);
      claimed.cascade = cascade;

      if (cascade.claimed.length) {
        await logActivity(
          lead.id,
          req.user.id,
          "claim",
          `Also took ${cascade.claimed.length} contact${
            cascade.claimed.length === 1 ? "" : "s"
          } at ${cascade.company}` +
            (cascade.takenOver.length
              ? ` — ${cascade.takenOver.length} reassigned from ${[
                  ...new Set(cascade.takenOver.map((t) => t.previous_owner || "someone else")),
                ].join(", ")}`
              : "")
        );
      }
    }

    if (source === "fresh") claimed.fresh_countdown = lifecycle.countdown(claimed.fresh_deadline_at, claimed.fresh_closed_at);
    else claimed.countdown = lifecycle.countdown(claimed.deadline_at, claimed.closed_at);

    res.json({ lead: claimed });
  } catch (err) {
    next(err);
  }
});

/** Close stops one track's clock. Reopen restarts that same track.
 *  `source` says which track — defaults to "all" for callers (like the
 *  drawer) that only ever manage the All Leads claim. */
router.post("/:id/close", async (req, res, next) => {
  try {
    const lead = await db.one("SELECT * FROM leads WHERE id = $1", [req.params.id]);
    if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

    const raw = req.body && req.body.source;
    const source = raw === "fresh" || raw === "newspaper" || raw === "all" ? raw : "all";
    const reopening = Boolean(req.body && req.body.reopen);
    const updated = reopening
      ? await lifecycle.reopen(lead.id, source)
      : await lifecycle.close(lead.id, source);

    await logActivity(
      lead.id,
      req.user.id,
      "status",
      `${reopening ? "Reopened" : "Marked closed"} — ${source === "fresh" ? "Fresh Leads" : "All Leads"} claim`
    );

    if (source === "fresh") updated.fresh_countdown = lifecycle.countdown(updated.fresh_deadline_at, updated.fresh_closed_at);
    else updated.countdown = lifecycle.countdown(updated.deadline_at, updated.closed_at);

    res.json({ lead: updated });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/activity", async (req, res, next) => {
  try {
    const lead = await db.one("SELECT * FROM leads WHERE id = $1", [req.params.id]);
    if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

    const kind = String((req.body && req.body.kind) || "note");
    const body = String((req.body && req.body.body) || "").trim();
    if (!body) return res.status(400).json({ error: "Write something before logging it." });

    await logActivity(lead.id, req.user.id, kind, body);

    if (CONTACT_KINDS.includes(kind)) {
      await db.run(
        `UPDATE leads
            SET last_contacted_at = now(),
                status = CASE WHEN status IN ('new','working') THEN 'contacted' ELSE status END,
                owner_id = COALESCE(owner_id, $1),
                updated_at = now()
          WHERE id = $2`,
        [req.user.id, lead.id]
      );
    }

    if (req.body && req.body.next_followup_at !== undefined) {
      await db.run("UPDATE leads SET next_followup_at = $1 WHERE id = $2", [
        req.body.next_followup_at || null,
        lead.id,
      ]);
    }

    const [fresh, activity] = await Promise.all([
      db.one("SELECT * FROM leads WHERE id = $1", [lead.id]),
      db.all(
        `SELECT a.id, a.kind, a.body, a.created_at, u.display_name AS user_name
           FROM activity a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.lead_id = $1 ORDER BY a.created_at DESC`,
        [lead.id]
      ),
    ]);

    fresh.countdown = lifecycle.countdown(fresh.deadline_at, fresh.closed_at);
    fresh.fresh_countdown = lifecycle.countdown(fresh.fresh_deadline_at, fresh.fresh_closed_at);
    res.json({ lead: fresh, activity });
  } catch (err) {
    next(err);
  }
});

function timeAgo(iso) {
  if (!iso) return null;
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return null;
  if (mins < 60) return "today";
  const hours = Math.round(mins / 60);
  if (hours < 24) return "today";
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months === 1 ? "last month" : `${months} months ago`;
}

function logActivity(leadId, userId, kind, body) {
  return db.run("INSERT INTO activity (lead_id, user_id, kind, body) VALUES ($1, $2, $3, $4)", [
    leadId,
    userId,
    kind,
    body,
  ]);
}

module.exports = router;
module.exports.STATUSES = STATUSES;
module.exports.OPEN_STATUSES = OPEN_STATUSES;
