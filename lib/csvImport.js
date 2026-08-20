/**
 * CSV import for the contact sheet.
 *
 * The export from the lead list is a PEOPLE sheet, not a company sheet — one
 * row per contact, with the company repeated across rows. So one upload feeds
 * two tables: `companies` (the watchlist) and `company_contacts` (the POCs).
 */

/**
 * Minimal RFC-4180 parser. Handles quoted fields, commas and newlines inside
 * quotes, and doubled quotes as an escape. Written by hand because the import
 * runs server-side and this is the only place we need it.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  // Strip a UTF-8 BOM — Excel adds one and it corrupts the first header.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }

    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }

  if (field.length || row.length) { row.push(field); rows.push(row); }

  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ""));
}

/** Header text -> comparable key, so "Work email" and "work_email" both match. */
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Which spreadsheet column feeds which field. Several aliases each, because
 * these exports get re-ordered and renamed between tools.
 */
const COLUMNS = {
  firstName:  ["firstname", "first"],
  lastName:   ["lastname", "last", "surname"],
  fullName:   ["name", "fullname", "contactname", "person"],
  company:    ["companyname", "company", "organisation", "organization", "account"],
  role:       ["positionofperson", "position", "title", "jobtitle", "designation", "role"],
  email:      ["workemail", "email", "emailaddress", "primaryemail"],
  altEmail:   ["additionalemail1", "additionalemail", "secondaryemail", "personalemail"],
  phone:       ["phone1", "phone", "mobile", "phonenumber", "contactnumber"],
  phoneType:   ["phone1type", "phonetype"],
  altPhone:    ["phone2", "additionalphone"],
  altPhoneType:["phone2type"],
  linkedin:   ["linkedinurl", "linkedin", "linkedinprofile"],
  seniority:  ["seniority", "level"],
  department: ["departments", "department", "function", "team"],
  domain:      ["companydomain", "domain"],
  founded:     ["companyyearfounded", "yearfounded", "founded"],
  website:     ["companywebsite", "website"],
  coLinkedin:  ["companylinkedinurl", "companylinkedin"],
  employees:   ["companynumberofemployees", "employees", "companysize", "headcount"],
  revenue:     ["companyrevenue", "revenue", "annualrevenue"],
  industry:    ["companymainindustry", "industry", "companyoldindustry"],
  subIndustry: ["companysubindustry"],
  city:        ["city", "location"],
  country:     ["country"],
  state:       ["state", "province", "region"],
  specialities:["companyspecialities", "companyspecialties", "specialities"],
};

/**
 * Only mobile numbers are useful — a landline or a switchboard number reaches
 * a reception desk, not the person. The sheet says which is which in its
 * "Phone 1 type" column, so trust that rather than guessing from the digits.
 * Where the type is missing, fall back to the shape of an Indian mobile:
 * ten digits starting 6-9, with or without a country code.
 */
function mobileOnly(number, type) {
  if (!number) return null;

  if (type) {
    const t = String(type).toLowerCase();
    if (t.includes("landline") || t.includes("switchboard") || t.includes("fax")) return null;
    if (t.includes("mobile") || t.includes("cell")) return number;
    // "direct" and anything else unrecognised falls through to the digit check.
  }

  const digits = String(number).replace(/\D/g, "").replace(/^(0|91)+/, "");
  if (digits.length !== 10) return null;
  if (!/^[6-9]/.test(digits)) return null;
  return number;
}

/** Cells that mean "no value" even though they aren't empty. */
const JUNK = new Set(["", "-", "n/a", "na", "null", "none", "#error!", "#n/a", "#value!", "#ref!"]);

function clean(v) {
  const s = String(v == null ? "" : v).trim();
  return JUNK.has(s.toLowerCase()) ? null : s;
}

/**
 * "POPxo | Good Glamm Group" is one company in the sheet but two names in the
 * news. Keep the full string as the display name and search on both halves,
 * or the sweep finds nothing for it.
 */
function keywordsFor(companyName) {
  const parts = companyName
    .split(/\s*[|/]\s*|\s+–\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 1);

  const seen = new Set();
  const out = [];
  for (const p of parts.length ? parts : [companyName]) {
    // Drop the legal suffix so "ITC Limited" also matches plain "ITC".
    const bare = p.replace(/\s+(pvt\.?|private)?\s*(ltd\.?|limited|inc\.?|llc|plc)$/i, "").trim();
    for (const k of [p, bare]) {
      if (k.length > 1 && !seen.has(k.toLowerCase())) {
        seen.add(k.toLowerCase());
        out.push(k);
      }
    }
  }
  return out;
}

/** Anyone whose title suggests they'd own an agency relationship. */
const DECISION_MAKER = /\b(head|chief|cxo|cmo|ceo|coo|director|vp|vice president|president|founder|owner|partner|lead)\b/i;

/**
 * Turn raw CSV text into { companies, contacts, skipped }.
 * Rows without a company name are unusable and get counted in `skipped`.
 */
function parseContactSheet(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return { companies: [], contacts: [], skipped: 0, headers: [] };
  }

  const headers = rows[0].map(norm);
  const index = {};
  for (const [field, aliases] of Object.entries(COLUMNS)) {
    const at = headers.findIndex((h) => aliases.includes(h));
    if (at !== -1) index[field] = at;
  }

  const get = (row, field) => (index[field] === undefined ? null : clean(row[index[field]]));

  const companies = new Map();   // lowercased name -> { name, keywords }
  const contacts = [];
  let skipped = 0;

  for (const row of rows.slice(1)) {
    const company = get(row, "company");
    if (!company) { skipped++; continue; }

    const key = company.toLowerCase();
    if (!companies.has(key)) {
      const industry = get(row, "industry");
      const sub = get(row, "subIndustry");
      companies.set(key, {
        name: company,
        keywords: keywordsFor(company),
        domain: get(row, "domain"),
        website: get(row, "website"),
        linkedin: get(row, "coLinkedin"),
        employees: get(row, "employees"),
        revenue: get(row, "revenue"),
        year_founded: get(row, "founded"),
        industry: [industry, sub].filter(Boolean).join(" · ") || null,
        specialities: get(row, "specialities"),
      });
    } else {
      // Later rows for the same company can carry fields the first row left
      // blank — the export isn't consistent about which row has what.
      const existing = companies.get(key);
      for (const [field, col] of [
        ["domain", "domain"], ["website", "website"], ["linkedin", "coLinkedin"],
        ["employees", "employees"], ["revenue", "revenue"], ["year_founded", "founded"],
      ]) {
        if (!existing[field]) existing[field] = get(row, col);
      }
      if (!existing.industry) {
        const industry = get(row, "industry");
        const sub = get(row, "subIndustry");
        existing.industry = [industry, sub].filter(Boolean).join(" · ") || null;
      }
    }

    const name =
      get(row, "fullName") ||
      [get(row, "firstName"), get(row, "lastName")].filter(Boolean).join(" ").trim();

    if (!name) continue;    // a company with no named person is still a company

    const role = get(row, "role");

    // Keep both numbers when both are mobiles — a second reachable number is
    // worth having. Landlines are still dropped either way.
    const mobiles = [
      mobileOnly(get(row, "phone"), get(row, "phoneType")),
      mobileOnly(get(row, "altPhone"), get(row, "altPhoneType")),
    ].filter(Boolean);

    const uniqueMobiles = [...new Set(mobiles)];
    const phone = uniqueMobiles[0] || null;
    const phoneAlt = uniqueMobiles[1] || null;

    contacts.push({
      company,
      name,
      role,
      email: get(row, "email"),
      phone,
      phone_alt: phoneAlt,
      phone_type: phone ? "mobile" : null,
      phone_alt_type: phoneAlt ? "mobile" : null,
      email_alt: get(row, "altEmail"),
      country: get(row, "country"),
      state: get(row, "state"),
      seniority: get(row, "seniority"),
      department: get(row, "department"),
      city: get(row, "city"),
      linkedin: get(row, "linkedin"),
      notes: [get(row, "department"), get(row, "seniority"), get(row, "city")]
        .filter(Boolean)
        .join(" · ") || null,
      // The sheet has several people per company; flag the senior one so the
      // drawer leads with someone who can actually say yes.
      is_primary: Boolean(role && DECISION_MAKER.test(role)),
    });
  }

  // Only one primary per company, otherwise the ordering is meaningless.
  const claimed = new Set();
  for (const c of contacts) {
    const key = c.company.toLowerCase();
    if (c.is_primary && claimed.has(key)) c.is_primary = false;
    else if (c.is_primary) claimed.add(key);
  }

  // Which sheet column fed which field, and which columns we ignored. When an
  // import lands companies but no people, this is what tells you why.
  const matched = {};
  for (const [field, at] of Object.entries(index)) matched[field] = rows[0][at];

  const usedIndexes = new Set(Object.values(index));
  const unmatched = rows[0].filter((h, i) => h && !usedIndexes.has(i));

  return {
    companies: [...companies.values()],
    contacts,
    skipped,
    headers: rows[0],
    matched,
    unmatched,
    rows: rows.length - 1,
  };
}

module.exports = { parseCsv, parseContactSheet, keywordsFor, mobileOnly };
