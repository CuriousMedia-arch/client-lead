/**
 * /api/contacts - the people directory.
 *
 * Lives in the same Supabase database as everything else now, so this is a
 * plain SQL table rather than a REST call.
 */
const express = require("express");
const db = require("../db");
const { requireAuth, requireAdmin } = require("../lib/auth");


const router = express.Router();
router.use(requireAuth);

// GET /api/contacts?company=Meesho
router.get("/", async (req, res, next) => {
  try {
    const company = String(req.query.company || "").trim();
    if (!company) return res.status(400).json({ error: "Which company?" });

    const contacts = await db.all(
      `SELECT id, name, role, email, phone, phone2, linkedin, notes,
              city, state, country, verified, verified_at, is_primary
         FROM company_contacts
        WHERE lower(company) = lower($1) AND deleted_at IS NULL
        ORDER BY is_primary DESC, name ASC`,
      [company]
    );

    res.json({ configured: true, contacts });
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts  { company, name, role, email, phone }
router.post("/", async (req, res, next) => {
  try {
    const b = req.body || {};
    const company = String(b.company || "").trim();
    const name = String(b.name || "").trim();
    if (!company || !name)
      return res.status(400).json({ error: "A company and a name are the minimum." });

    const clean = (v) => (String(v || "").trim() || null);

    // A contact typed against a company nobody has imported means the company
    // is missing from the database, not that the contact is invalid. Create
    // both, approved, so it appears in All Leads — a person you're already
    // ringing belongs in the database, not in a side note on one lead.
    const known = await db.one("SELECT id, approval FROM companies WHERE lower(name) = lower($1)", [
      company,
    ]);

    let companyCreated = false;
    if (!known) {
      const made = await db.one(
        `INSERT INTO companies (name, keywords, active, origin, approval)
         VALUES ($1, $2::jsonb, true, 'watchlist', 'approved')
         ON CONFLICT (lower(name)) DO NOTHING
         RETURNING id`,
        [company, JSON.stringify([company])]
      );
      companyCreated = Boolean(made);

      if (made) {
        await db.run(
          "INSERT INTO leads (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING",
          [made.id]
        );
      }
    } else if (known.approval !== "approved") {
      // Discovered by the sweep but never approved. Someone working it by hand
      // is the approval.
      await db.run("UPDATE companies SET approval = 'approved', active = true WHERE id = $1", [
        known.id,
      ]);
      companyCreated = true;
    }

    const contact = await db.one(
      `INSERT INTO company_contacts (company, name, role, email, phone, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (lower(company), lower(name)) DO UPDATE
          SET role       = COALESCE(EXCLUDED.role, company_contacts.role),
              email      = COALESCE(EXCLUDED.email, company_contacts.email),
              phone      = COALESCE(EXCLUDED.phone, company_contacts.phone),
              is_primary = EXCLUDED.is_primary
       RETURNING id, name, role, email, phone, phone2, linkedin, notes, is_primary`,
      [company, name, clean(b.role), clean(b.email), clean(b.phone), Boolean(b.is_primary)]
    );

    await db.run(
      `INSERT INTO contact_originals (contact_id, company, name, role, email, phone)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (contact_id) DO NOTHING`,
      [contact.id, company, name, clean(b.role), clean(b.email), clean(b.phone)]
    );

    res.json({ contact, companyCreated, company });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/contacts/:id
router.delete("/:id", async (req, res, next) => {
  try {
    await db.run("DELETE FROM company_contacts WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── All Leads: the people table ────────────────────────────────────────────
//
// All Leads is one row per person now, so a CONTACT is what gets claimed
// there — same 30-day window an All Leads company claim carried. Two reps can
// work two people at one company without treading on each other. An expired
// person claim returns to the pool; only Fresh Leads claims go to the
// Newspaper, and those live on the lead, untouched by any of this.

const CLAIM_DAYS = Number(process.env.CLAIM_DAYS_ALL || 30);

/**
 * Release every person claim whose clock has run out.
 *
 * The query itself moved to lib/sweeps.js when the background cron was added,
 * so the scheduled run and the on-request run cannot drift apart. This wrapper
 * stays because several handlers below call it by name.
 */
const sweeps = require("../lib/sweeps");
const sweepExpiredContacts = sweeps.sweepExpiredContacts;

function contactCountdown(row) {
  if (!row || !row.deadline_at || row.closed_at) return null;

  const msLeft = new Date(row.deadline_at).getTime() - Date.now();
  if (msLeft <= 0) return { label: "Overdue", days: 0, urgent: true, overdue: true };

  const days = Math.floor(msLeft / 86400000);
  const hours = Math.floor((msLeft % 86400000) / 3600000);
  return {
    label: days >= 1 ? `${days}d ${hours}h left` : `${hours}h left`,
    days,
    urgent: days < 3,
    overdue: false,
  };
}

const PEOPLE_SELECT = `
  SELECT cc.*,
         c.website      AS company_website,
         c.domain       AS company_domain,
         c.linkedin     AS company_linkedin,
         c.founded      AS company_founded,
         c.employees    AS company_employees,
         c.revenue      AS company_revenue,
         c.industry     AS company_industry,
         c.specialities AS company_specialities,
         u.display_name  AS owner_name,
         vu.display_name AS verified_by_name
    FROM company_contacts cc
    LEFT JOIN companies c ON lower(c.name) = lower(cc.company)
    LEFT JOIN users u  ON u.id  = cc.owner_id
    LEFT JOIN users vu ON vu.id = cc.verified_by`;

/** GET /api/contacts/people?q=&mine=1&sort= */
router.get("/people", async (req, res, next) => {
  try {
    await sweepExpiredContacts();

    const where = [];
    const args = [];
    const bind = (v) => `$${args.push(v)}`;

    where.push("cc.deleted_at IS NULL");
    if (req.query.mine === "1") where.push(`cc.owner_id = ${bind(req.user.id)}`);
    if (req.query.q) {
      const q = bind(`%${String(req.query.q).toLowerCase()}%`);
      where.push(
        `(LOWER(cc.name) LIKE ${q} OR LOWER(cc.company) LIKE ${q} OR LOWER(COALESCE(cc.role,'')) LIKE ${q})`
      );
    }

    const sortMap = {
      name: "LOWER(cc.name) ASC",
      company: "LOWER(cc.company) ASC, cc.is_primary DESC, LOWER(cc.name) ASC",
      urgent: "cc.deadline_at ASC NULLS LAST, LOWER(cc.name) ASC",
    };

    const contacts = await db.all(
      `${PEOPLE_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY ${sortMap[req.query.sort] || sortMap.company} LIMIT 1000`,
      args
    );

    for (const c of contacts) c.countdown = contactCountdown(c);
    res.json({ contacts, claimDays: CLAIM_DAYS });
  } catch (err) {
    next(err);
  }
});

/** Claim or release one person. */
router.post("/:id/claim", async (req, res, next) => {
  try {
    const releasing = Boolean(req.body && req.body.release);

    // A claim locks the person. Nobody but the owner can touch it — no silent
    // take-overs — except an admin, who can always hand a lead back so it
    // doesn't get stranded when someone leaves or goes on holiday.
    const current = await db.one("SELECT owner_id FROM company_contacts WHERE id = $1", [
      req.params.id,
    ]);
    if (!current) return res.status(404).json({ error: "That contact no longer exists." });

    const isAdmin = req.user.role === "admin";
    const isOwner = current.owner_id === req.user.id;

    // Check the release case first: refusing it as "already claimed" would be
    // technically true but answers a question nobody asked.
    if (releasing && !isOwner && !isAdmin) {
      return res.status(403).json({ error: "Only the owner can release this contact." });
    }
    // One contact per company per person, on MANUAL claims. Holding three
    // people at one company by hand is hoarding, not working the account — a
    // colleague should be able to take a different contact there.
    //
    // Contacts that arrived with a Fresh Leads company claim don't count
    // against it (claim_source = 'fresh'). Whoever holds the Fresh Lead is
    // meant to have the whole account for those ten days, so the cap would
    // otherwise lock them out of the one contact the sweep couldn't take.
    if (!releasing && !isOwner) {
      const held = await db.one(
        `SELECT cc.name FROM company_contacts cc
          WHERE cc.owner_id = $1
            AND cc.deleted_at IS NULL
            AND cc.closed_at IS NULL
            AND COALESCE(cc.claim_source, 'all') <> 'fresh'
            AND lower(cc.company) = (SELECT lower(company) FROM company_contacts WHERE id = $2)
            AND cc.id <> $2
          LIMIT 1`,
        [req.user.id, req.params.id]
      );
      if (held) {
        return res.status(409).json({
          error: `You already have ${held.name} at this company. Close or release them first.`,
        });
      }
    }

    if (!releasing && current.owner_id && !isOwner && !isAdmin) {
      return res.status(409).json({
        error: "Someone else is already working this contact.",
      });
    }

    const note = String((req.body && req.body.note) || "").trim();
    if (releasing && note.length < 3) {
      return res.status(400).json({
        error: "Say why you're releasing it, so whoever picks it up knows where things stand.",
      });
    }

    const row = releasing
      ? await db.one(
          `UPDATE company_contacts
              SET owner_id = NULL, claimed_at = NULL, deadline_at = NULL,
                  claim_source = NULL, status = 'new', release_note = $2
            WHERE id = $1 RETURNING *`,
          [req.params.id, note]
        )
      : await (async () => {
          await db.run(
            `INSERT INTO contact_claims (contact_id, user_id)
             VALUES ($1, $2) ON CONFLICT (contact_id, user_id) DO NOTHING`,
            [req.params.id, req.user.id]
          );
          return db.one(
          // claim_count is "how many distinct people have claimed this,"
          // not "how many times." contact_claims has one row per
          // (contact, user), so a person releasing and re-claiming the same
          // contact only ever counts once — the INSERT is a no-op the
          // second time round.
          // The INSERT has to be its own statement: a data-modifying CTE isn't
          // visible to the rest of the statement it sits in, so counting inside
          // the same query always returned the tally from before this claim.
          `UPDATE company_contacts
              SET owner_id = $1, claimed_at = now(),
                  deadline_at = now() + ($2 || ' days')::interval,
                  closed_at = NULL,
                  claim_source = 'all',
                  claim_count = (SELECT COUNT(*) FROM contact_claims WHERE contact_id = $3),
                  status = CASE WHEN status = 'new' THEN 'working' ELSE status END
            WHERE id = $3 RETURNING *`,
            [req.user.id, CLAIM_DAYS, req.params.id]
          );
        })();

    if (!row) return res.status(404).json({ error: "That contact no longer exists." });

    // The reason goes in the log too, so it sits in the history rather than
    // only on the row where the next edit could overwrite it.
    if (releasing) {
      await db.run(
        "INSERT INTO contact_activity (contact_id, user_id, kind, body) VALUES ($1,$2,'note',$3)",
        [req.params.id, req.user.id, `Released — ${note}`]
      );
    }

    row.countdown = contactCountdown(row);
    res.json({ contact: row });
  } catch (err) {
    next(err);
  }
});

/** Close stops the clock; reopen restarts it. */
router.post("/:id/close", async (req, res, next) => {
  try {
    const reopening = Boolean(req.body && req.body.reopen);

    const current = await db.one("SELECT owner_id FROM company_contacts WHERE id = $1", [
      req.params.id,
    ]);
    if (!current) return res.status(404).json({ error: "That contact no longer exists." });

    if (current.owner_id !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the owner can close this contact." });
    }

    const row = reopening
      ? await db.one(
          `UPDATE company_contacts
              SET closed_at = NULL, claimed_at = now(),
                  deadline_at = now() + ($1 || ' days')::interval
            WHERE id = $2 RETURNING *`,
          [CLAIM_DAYS, req.params.id]
        )
      : await db.one(
          `UPDATE company_contacts
              SET closed_at = now(), deadline_at = NULL, status = 'won'
            WHERE id = $1 RETURNING *`,
          [req.params.id]
        );

    if (!row) return res.status(404).json({ error: "That contact no longer exists." });

    row.countdown = contactCountdown(row);
    res.json({ contact: row });
  } catch (err) {
    next(err);
  }
});

/* ── Progress log ───────────────────────────────────────────────────────────
 *
 * What was said, when, and by whom. Only the owner writes to it (or an admin),
 * because a log anyone can edit stops being a record of what happened.
 */

const KINDS = ["note", "call", "email", "linkedin", "meeting"];
const STAGES = ["new", "working", "contacted", "replied", "qualified", "won", "lost"];

router.get("/people/:id/activity", async (req, res, next) => {
  try {
    const rows = await db.all(
      `SELECT a.id, a.kind, a.body, a.stage, a.created_at, u.display_name AS user_name
         FROM contact_activity a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.contact_id = $1
        ORDER BY a.created_at DESC`,
      [req.params.id]
    );
    res.json({ activity: rows });
  } catch (err) {
    next(err);
  }
});

router.post("/people/:id/activity", async (req, res, next) => {
  try {
    const contact = await db.one(
      "SELECT owner_id, status FROM company_contacts WHERE id = $1",
      [req.params.id]
    );
    if (!contact) return res.status(404).json({ error: "That contact no longer exists." });

    if (contact.owner_id !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the owner can log progress on this contact." });
    }

    const body = String((req.body && req.body.body) || "").trim();
    if (!body) return res.status(400).json({ error: "Write what was discussed before saving." });

    const kind = KINDS.includes(req.body && req.body.kind) ? req.body.kind : "note";
    const stage = STAGES.includes(req.body && req.body.stage) ? req.body.stage : null;

    await db.run(
      "INSERT INTO contact_activity (contact_id, user_id, kind, body, stage) VALUES ($1,$2,$3,$4,$5)",
      [req.params.id, req.user.id, kind, body, stage]
    );

    // Logging a real conversation moves the contact along, so the stage on the
    // card matches the last thing that actually happened.
    if (stage) {
      await db.run("UPDATE company_contacts SET status = $1 WHERE id = $2", [stage, req.params.id]);
    } else if (kind !== "note" && contact.status === "new") {
      await db.run("UPDATE company_contacts SET status = 'contacted' WHERE id = $1", [req.params.id]);
    }

    // Working a contact is working the company: it resets the Fresh claim's
    // idle clock, so someone genuinely busy is never auto-released.
    await db.run(
      `UPDATE leads SET fresh_last_activity_at = now(), fresh_warned_at = NULL
        WHERE fresh_owner_id IS NOT NULL
          AND company_id = (SELECT id FROM companies
                             WHERE lower(name) = (SELECT lower(company) FROM company_contacts WHERE id = $1))`,
      [req.params.id]
    ).catch(() => {});

    const [activity, fresh] = await Promise.all([
      db.all(
        `SELECT a.id, a.kind, a.body, a.stage, a.created_at, u.display_name AS user_name
           FROM contact_activity a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.contact_id = $1 ORDER BY a.created_at DESC`,
        [req.params.id]
      ),
      db.one("SELECT * FROM company_contacts WHERE id = $1", [req.params.id]),
    ]);

    fresh.countdown = contactCountdown(fresh);
    res.json({ activity, contact: fresh });
  } catch (err) {
    next(err);
  }
});

/**
 * Editing a row is admin-only. Everyone else reads the database; only an admin
 * corrects it, so a typo fixed in one place stays fixed for the whole team.
 */
// Fields that live on the contact.
const EDITABLE = [
  "name", "role", "email", "email_alt", "phone", "phone2",
  "linkedin", "seniority", "department", "city", "country", "state",
];

// Fields that live on the company. Editing these from a contact updates the
// company itself, so every contact there sees the correction — a website fixed
// once is fixed for all ten people at that firm.
const COMPANY_EDITABLE = ["website", "linkedin", "domain", "industry", "employees", "revenue", "founded"];

router.patch("/people/:id", async (req, res, next) => {
  try {
    // Anyone on the team can correct a record — a wrong phone number helps
    // nobody. Deleting is a different matter and stays with admins.
    const before = await db.one("SELECT * FROM company_contacts WHERE id = $1", [req.params.id]);
    if (!before) return res.status(404).json({ error: "That contact no longer exists." });

    const sets = [];
    const args = [];
    const bind = (v) => `$${args.push(v)}`;

    for (const field of EDITABLE) {
      if (req.body[field] === undefined) continue;
      const value = String(req.body[field] || "").trim() || null;
      if (field === "name" && !value) {
        return res.status(400).json({ error: "A contact needs a name." });
      }
      sets.push(`${field} = ${bind(value)}`);
    }

    let row = before;

    if (sets.length) {
      row = await db.one(
        `UPDATE company_contacts SET ${sets.join(", ")} WHERE id = ${bind(req.params.id)} RETURNING *`,
        args
      );
      if (!row) return res.status(404).json({ error: "That contact no longer exists." });
    }

    // --- company-level edits -------------------------------------------------
    const company = await db.one("SELECT * FROM companies WHERE lower(name) = lower($1)", [
      before.company,
    ]);

    if (company) {
      const cSets = [];
      const cArgs = [];
      const cBind = (v) => `$${cArgs.push(v)}`;

      for (const field of COMPANY_EDITABLE) {
        const key = `company_${field}`;
        if (req.body[key] === undefined) continue;
        const value = String(req.body[key] || "").trim() || null;
        if (String(company[field] ?? "") === String(value ?? "")) continue;
        cSets.push(`${field} = ${cBind(value)}`);

        await db.run(
          `INSERT INTO contact_changes (contact_id, user_id, field, old_value, new_value)
           VALUES ($1,$2,$3,$4,$5)`,
          [req.params.id, req.user.id, key, company[field], value]
        );
      }

      if (cSets.length) {
        await db.run(`UPDATE companies SET ${cSets.join(", ")} WHERE id = ${cBind(company.id)}`, cArgs);
      }

      // Renaming a company has to move its contacts with it, or they're
      // orphaned from the company record and lose their firmographics.
      const newName = req.body.company === undefined ? null : String(req.body.company || "").trim();
      if (newName && newName.toLowerCase() !== company.name.toLowerCase()) {
        const clash = await db.one(
          "SELECT id FROM companies WHERE lower(name) = lower($1) AND id <> $2",
          [newName, company.id]
        );
        if (clash) {
          return res.status(409).json({ error: `${newName} already exists as a separate company.` });
        }

        await db.run("UPDATE companies SET name = $1 WHERE id = $2", [newName, company.id]);
        await db.run("UPDATE company_contacts SET company = $1 WHERE lower(company) = lower($2)", [
          newName,
          company.name,
        ]);

        await db.run(
          `INSERT INTO contact_changes (contact_id, user_id, field, old_value, new_value)
           VALUES ($1,$2,'company',$3,$4)`,
          [req.params.id, req.user.id, company.name, newName]
        );

        row = await db.one("SELECT * FROM company_contacts WHERE id = $1", [req.params.id]);
      }
    }

    if (!sets.length && !Object.keys(req.body).some((k) => k.startsWith("company"))) {
      return res.status(400).json({ error: "Nothing to change." });
    }

    // One log entry per field that actually moved. Append-only: the history is
    // a record of what happened, not something to be tidied up later.
    for (const field of EDITABLE) {
      if (req.body[field] === undefined) continue;
      const oldValue = before[field] === null ? null : String(before[field]);
      const newValue = row[field] === null ? null : String(row[field]);
      if (oldValue === newValue) continue;

      await db.run(
        `INSERT INTO contact_changes (contact_id, user_id, field, old_value, new_value)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.params.id, req.user.id, field, oldValue, newValue]
      );
    }

    row.countdown = contactCountdown(row);
    res.json({ contact: row });
  } catch (err) {
    // The unique index means two people at one company can't share a name.
    if (err.code === "23505") {
      return res.status(409).json({ error: "That company already has someone with this name." });
    }
    next(err);
  }
});

/**
 * Verified / Unverified — one flag, shared by the whole team.
 *
 * Anyone signed in can set it, because anyone can be the person who rang the
 * number and found it works. The point is that the next person doesn't have to
 * ring it again, so it can't be a per-user preference: it's stamped on the row
 * with who did it and when, and it shows for everybody.
 *
 * It goes in the change log too, so "who said this was good?" is answerable
 * six weeks later when the number turns out to be dead after all.
 */
router.post("/people/:id/verify", async (req, res, next) => {
  try {
    const verified = req.body && req.body.verified === false ? false : true;

    const before = await db.one(
      "SELECT verified FROM company_contacts WHERE id = $1 AND deleted_at IS NULL",
      [req.params.id]
    );
    if (!before) return res.status(404).json({ error: "That contact no longer exists." });

    const row = await db.one(
      `UPDATE company_contacts
          SET verified    = $1,
              verified_by = CASE WHEN $1 THEN $2::bigint ELSE NULL END,
              verified_at = CASE WHEN $1 THEN now() ELSE NULL END
        WHERE id = $3
        RETURNING *`,
      [verified, req.user.id, req.params.id]
    );

    // No change-log entry here on purpose — Verified/Unverified isn't history,
    // it's a status. verified_at already carries "the latest date it was
    // checked," and re-verifying just moves that date forward. Logging every
    // toggle would just be noise in the timeline.

    row.countdown = contactCountdown(row);
    res.json({ contact: row, verified_by_name: verified ? req.user.display_name : null });
  } catch (err) {
    next(err);
  }
});

/** What the sheet said, and everything that's happened to it since. */
router.get("/people/:id/history", async (req, res, next) => {
  try {
    const [original, changes] = await Promise.all([
      db.one("SELECT * FROM contact_originals WHERE contact_id = $1", [req.params.id]),
      db.all(
        `SELECT ch.field, ch.old_value, ch.new_value, ch.changed_at, u.display_name AS user_name
           FROM contact_changes ch LEFT JOIN users u ON u.id = ch.user_id
          WHERE ch.contact_id = $1
          ORDER BY ch.changed_at DESC`,
        [req.params.id]
      ),
    ]);

    res.json({ original: original || null, changes });
  } catch (err) {
    next(err);
  }
});

/**
 * Delete hides the contact rather than destroying it.
 *
 * Its import snapshot, edit history and outreach log all hang off this row by
 * foreign key — a real DELETE would take them with it. Marking it deleted keeps
 * the record and makes the action reversible.
 */
router.delete("/people/:id", requireAdmin, async (req, res, next) => {
  try {
    const row = await db.one(
      `UPDATE company_contacts
          SET deleted_at = now(), deleted_by = $1,
              owner_id = NULL, claimed_at = NULL, deadline_at = NULL
        WHERE id = $2 AND deleted_at IS NULL
        RETURNING id, name`,
      [req.user.id, req.params.id]
    );
    if (!row) return res.status(404).json({ error: "That contact no longer exists." });

    await db.run(
      `INSERT INTO contact_changes (contact_id, user_id, field, old_value, new_value)
       VALUES ($1, $2, 'deleted', 'active', 'deleted')`,
      [req.params.id, req.user.id]
    );

    res.json({ ok: true, name: row.name });
  } catch (err) {
    next(err);
  }
});

/** Everything an admin has deleted, newest first. */
router.get("/deleted", requireAdmin, async (req, res, next) => {
  try {
    const contacts = await db.all(
      `SELECT cc.id, cc.name, cc.company, cc.role, cc.email, cc.phone,
              cc.deleted_at, u.display_name AS deleted_by_name
         FROM company_contacts cc
         LEFT JOIN users u ON u.id = cc.deleted_by
        WHERE cc.deleted_at IS NOT NULL
        ORDER BY cc.deleted_at DESC
        LIMIT 500`
    );
    res.json({ contacts });
  } catch (err) {
    next(err);
  }
});

/** Put one back. */
router.post("/people/:id/restore", requireAdmin, async (req, res, next) => {
  try {
    const clash = await db.one(
      `SELECT id FROM company_contacts
        WHERE deleted_at IS NULL AND id <> $1
          AND lower(company) = (SELECT lower(company) FROM company_contacts WHERE id = $1)
          AND lower(name)    = (SELECT lower(name)    FROM company_contacts WHERE id = $1)`,
      [req.params.id]
    );
    if (clash) {
      return res.status(409).json({
        error: "That person has since been added again. Delete the duplicate first.",
      });
    }

    const row = await db.one(
      "UPDATE company_contacts SET deleted_at = NULL, deleted_by = NULL WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: "That contact no longer exists." });

    await db.run(
      `INSERT INTO contact_changes (contact_id, user_id, field, old_value, new_value)
       VALUES ($1, $2, 'deleted', 'deleted', 'active')`,
      [req.params.id, req.user.id]
    );

    res.json({ contact: row });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/contacts/my-alerts
 * Claims this user owns on All Leads that hit their deadline within 5 days,
 * plus (admin only) how many extension requests are waiting on a decision.
 * Powers the notification bell.
 */
router.get("/my-alerts", async (req, res, next) => {
  try {
    await sweepExpiredContacts();

    const expiring = await db.all(
      `SELECT id, name, company, deadline_at
         FROM company_contacts
        WHERE owner_id = $1 AND deleted_at IS NULL AND closed_at IS NULL
          AND deadline_at IS NOT NULL
          AND deadline_at <= now() + interval '5 days'
        ORDER BY deadline_at ASC`,
      [req.user.id]
    );
    for (const c of expiring) c.countdown = contactCountdown(c);

    const myPending = await db.all(
      `SELECT id, status FROM extension_requests WHERE user_id = $1 AND status = 'pending'`,
      [req.user.id]
    );

    let pendingReview = 0;
    if (req.user.role === "admin") {
      pendingReview = await db.value(
        "SELECT count(*)::int AS n FROM extension_requests WHERE status = 'pending'"
      );
    }

    res.json({ expiring, myPendingRequests: myPending.length, pendingReview: pendingReview || 0 });
  } catch (err) {
    next(err);
  }
});

/** POST /api/contacts/:id/request-extension { reason } */
router.post("/:id/request-extension", async (req, res, next) => {
  try {
    const reason = String((req.body && req.body.reason) || "").trim();
    if (reason.length < 3) return res.status(400).json({ error: "Say why you need more time." });

    const contact = await db.one(
      "SELECT id, owner_id FROM company_contacts WHERE id = $1 AND deleted_at IS NULL",
      [req.params.id]
    );
    if (!contact) return res.status(404).json({ error: "That contact no longer exists." });
    if (contact.owner_id !== req.user.id) {
      return res.status(403).json({ error: "Only the owner can request an extension on this." });
    }

    const existing = await db.all(
      "SELECT id FROM extension_requests WHERE contact_id = $1 AND status = 'pending'",
      [req.params.id]
    );
    if (existing.length) {
      return res.status(409).json({ error: "You already have a pending extension request on this one." });
    }

    const row = await db.one(
      `INSERT INTO extension_requests (contact_id, user_id, reason)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, req.user.id, reason]
    );

    res.json({ request: row });
  } catch (err) {
    next(err);
  }
});

/** GET /api/contacts/extension-requests — admin inbox. */
router.get("/extension-requests", requireAdmin, async (req, res, next) => {
  try {
    const requests = await db.all(
      `SELECT er.*, cc.name AS contact_name, cc.company, u.display_name AS requested_by
         FROM extension_requests er
         JOIN company_contacts cc ON cc.id = er.contact_id
         JOIN users u ON u.id = er.user_id
        WHERE er.status = 'pending'
        ORDER BY er.created_at ASC`
    );
    res.json({ requests });
  } catch (err) {
    next(err);
  }
});

/** POST /api/contacts/extension-requests/:id/resolve { approve, days } */
router.post("/extension-requests/:id/resolve", requireAdmin, async (req, res, next) => {
  try {
    const approve = Boolean(req.body && req.body.approve);
    const days = Number(req.body && req.body.days);

    const request = await db.one(
      "SELECT * FROM extension_requests WHERE id = $1 AND status = 'pending'",
      [req.params.id]
    );
    if (!request) return res.status(404).json({ error: "That request has already been handled." });

    if (approve) {
      if (!days || days < 1) return res.status(400).json({ error: "Enter how many days to grant." });

      // Add the granted days on top of the deadline that's already there,
      // instead of resetting the clock to "now + days" — the rep still has
      // whatever time was left, plus this extension.
      await db.run(
        `UPDATE company_contacts
            SET deadline_at = COALESCE(deadline_at, now()) + ($1 || ' days')::interval
          WHERE id = $2`,
        [days, request.contact_id]
      );
      await db.run(
        `UPDATE extension_requests
            SET status = 'approved', granted_days = $1, resolved_at = now(), resolved_by = $2
          WHERE id = $3`,
        [days, req.user.id, req.params.id]
      );
    } else {
      await db.run(
        `UPDATE extension_requests
            SET status = 'denied', resolved_at = now(), resolved_by = $1
          WHERE id = $2`,
        [req.user.id, req.params.id]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** GET /api/contacts/company-lookup?name= — autofill for the New Lead dialog. */
router.get("/company-lookup", async (req, res, next) => {
  try {
    const name = String(req.query.name || "").trim();
    if (!name) return res.json({ company: null });

    const company = await db.all(
      `SELECT name, domain, website, linkedin, industry, employees, revenue, founded, city, state
         FROM companies WHERE lower(name) = lower($1) LIMIT 1`,
      [name]
    );
    res.json({ company: company[0] || null });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/contacts/new-lead — the "+ New Lead" dialog.
 * Same shape as one CSV row. Company is upserted the same way the importer
 * does it; the contact is a plain insert guarded by the duplicate check
 * below — company + phone + name all matching means this is the same
 * person the sheet or a colleague already logged, not a new row.
 */
router.post("/new-lead", requireAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const clean = (v) => String(v || "").trim() || null;

    const company = clean(b.company);
    const name = clean(b.name);
    if (!company || !name) {
      return res.status(400).json({ error: "A company and a name are the minimum." });
    }
    const phone = clean(b.phone);

    const dupe = await db.all(
      `SELECT id FROM company_contacts
        WHERE lower(company) = lower($1) AND lower(name) = lower($2)
          AND phone IS NOT DISTINCT FROM $3 AND deleted_at IS NULL`,
      [company, name, phone]
    );
    if (dupe.length) {
      return res.status(409).json({
        error: "This lead already exists — same company, name and phone number.",
      });
    }

    let contact;
    await db.tx(async (q) => {
      await q(
        `INSERT INTO companies
           (name, keywords, active, origin, approval,
            domain, website, linkedin, employees, revenue, industry, founded, city, state)
         VALUES ($1, '[]'::jsonb, true, 'watchlist', 'approved', $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (lower(name)) DO UPDATE
            SET domain    = COALESCE(EXCLUDED.domain,    companies.domain),
                website   = COALESCE(EXCLUDED.website,   companies.website),
                linkedin  = COALESCE(EXCLUDED.linkedin,  companies.linkedin),
                employees = COALESCE(EXCLUDED.employees, companies.employees),
                revenue   = COALESCE(EXCLUDED.revenue,   companies.revenue),
                industry  = COALESCE(EXCLUDED.industry,  companies.industry),
                founded   = COALESCE(EXCLUDED.founded,   companies.founded),
                city      = COALESCE(EXCLUDED.city,      companies.city),
                state     = COALESCE(EXCLUDED.state,     companies.state)`,
        [company, clean(b.company_domain), clean(b.company_website), clean(b.company_linkedin),
         clean(b.company_employees), clean(b.company_revenue), clean(b.company_industry),
         clean(b.company_founded), clean(b.city), clean(b.state)]
      );

      await q(
        `INSERT INTO leads (company_id)
         SELECT id FROM companies WHERE lower(name) = lower($1)
         ON CONFLICT (company_id) DO NOTHING`,
        [company]
      );

      const { rows } = await q(
        `INSERT INTO company_contacts
           (company, name, role, email, phone, phone2, linkedin,
            seniority, department, city, country, state, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [company, name, clean(b.role), clean(b.email), phone, clean(b.phone2), clean(b.linkedin),
         clean(b.seniority), clean(b.department), clean(b.city), clean(b.country), clean(b.state),
         Boolean(b.is_primary)]
      );
      contact = rows[0];

      await q(
        `INSERT INTO contact_originals
           (contact_id, company, name, role, email, phone, phone2, linkedin,
            seniority, department, city, country, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (contact_id) DO NOTHING`,
        [contact.id, company, name, clean(b.role), clean(b.email), phone, clean(b.phone2),
         clean(b.linkedin), clean(b.seniority), clean(b.department), clean(b.city),
         clean(b.country), clean(b.state)]
      );
    });

    res.json({ contact });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.sweepExpiredContacts = sweepExpiredContacts;
