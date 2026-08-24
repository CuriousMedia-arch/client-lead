/**
 * The intelligence behind My Outreach (brief items 4, 8, 11, 17, 19, 21, 22).
 *
 * Every function here has two paths: Gemini if a key is configured, and a
 * rules fallback derived from lib/triggers.js if it is not. That is deliberate
 * — the portal has already shipped once with an AI call that silently returned
 * nothing, and a salesperson staring at an empty "Recommended Solution" box
 * has no idea whether the system is thinking or broken. The fallback is never
 * as good, but it is always there, and every response says which one produced
 * it so the UI can be honest about it.
 *
 * Prompts ask for JSON only. lib/gemini.js already sets
 * responseMimeType: application/json, but models still occasionally wrap the
 * object in a fence, so parseJson strips one before giving up.
 */
const gemini = require("./gemini");
const triggers = require("./triggers");

const CREDENTIALS = `Curious Media is an Indian creator-marketing agency. It runs
influencer campaigns, meme-page distribution, UGC content production (Curious
Studios) and paid content distribution, mostly for D2C, consumer tech, fintech
and retail brands targeting Indian audiences aged 18-34.`;

const SERVICES = [
  "Influencer Marketing",
  "Meme Marketing",
  "Content Distribution",
  "Curious Studios",
];

/** Strip a code fence if the model added one, then parse. Returns null on failure. */
function parseJson(text) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Occasionally there is prose around the object. Take the outermost braces.
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

async function ask(prompt) {
  if (!gemini.configured()) return null;
  try {
    return parseJson(await gemini.generate(prompt));
  } catch (err) {
    console.warn("[outreachAI]", err.message);
    return null;
  }
}

/** A compact description of the opportunity, reused by every prompt below. */
function contextBlock(ctx) {
  const lines = [
    `Company: ${ctx.company || "unknown"}`,
    ctx.industry && `Industry: ${ctx.industry}`,
    ctx.employees && `Headcount: ${ctx.employees}`,
    ctx.contact_name && `Contact: ${ctx.contact_name}${ctx.contact_role ? `, ${ctx.contact_role}` : ""}`,
    ctx.signal_title && `Recent news: ${ctx.signal_title}`,
    ctx.signal_type && `Signal type: ${ctx.signal_type}`,
    ctx.signal_summary && `What happened: ${ctx.signal_summary}`,
    ctx.service && `Service being pitched: ${ctx.service}`,
    ctx.plan_name && `Plan: ${ctx.plan_name}`,
    ctx.price && `Price being quoted: INR ${Number(ctx.price).toLocaleString("en-IN")}`,
  ].filter(Boolean);
  return lines.join("\n");
}

/* ── Item 4: which service to pitch ───────────────────────────────────────── */

/**
 * The brief is blunt about why this exists: "Don't make the salesperson decide
 * everything." A primary, a secondary, an optional, and — the part that
 * actually gets it accepted — a reason in one sentence the salesperson can
 * repeat to the client.
 */
async function recommendService(ctx) {
  const ai = await ask(
    `${CREDENTIALS}

Pick which Curious Media services to pitch to this company.

${contextBlock(ctx)}

Available services: ${SERVICES.join(", ")}.

Return ONLY this JSON:
{"primary":"<one service>","secondary":"<one service or null>","optional":"<one service or null>","why":"<one sentence, max 30 words, referring to this company's actual situation>"}`
  );

  if (ai && ai.primary && SERVICES.includes(ai.primary)) {
    return {
      primary: ai.primary,
      secondary: SERVICES.includes(ai.secondary) ? ai.secondary : null,
      optional: SERVICES.includes(ai.optional) ? ai.optional : null,
      why: String(ai.why || "").slice(0, 240),
      source: "ai",
    };
  }

  // Fallback: the playbook already maps every signal type to an angle.
  const seg = triggers.SEGMENTS.find((s) => s.id === ctx.signal_type);
  const byAngle = {
    "Meme & Influencer Takeover": ["Influencer Marketing", "Meme Marketing", "Content Distribution"],
    "Creator UGC & Meme Surges": ["Meme Marketing", "Influencer Marketing", "Curious Studios"],
    "Curious Studios Retainer": ["Curious Studios", "Influencer Marketing", "Content Distribution"],
    "Introductory Credential Drop": ["Influencer Marketing", "Content Distribution", null],
    "Meme Sentiment Flipping": ["Meme Marketing", "Content Distribution", null],
  };
  const picked = (seg && byAngle[seg.angle]) || ["Influencer Marketing", "Meme Marketing", null];

  return {
    primary: picked[0],
    secondary: picked[1] || null,
    optional: picked[2] || null,
    why: seg
      ? seg.say(ctx.company || "this company").split(".")[0] + "."
      : `No strong buying trigger on file for ${ctx.company || "this company"} — open with discovery rather than a fixed service.`,
    source: "rules",
  };
}

/* ── Item 8: the pitch, on five channels ──────────────────────────────────── */

/**
 * One generation, five outputs, because a salesperson working an opportunity
 * will try more than one channel and rewriting the same argument by hand each
 * time is how the argument drifts.
 *
 * The prompt is loaded with everything the brief lists — company, signal,
 * industry, designation, service, plan, credentials — precisely so the email
 * does not read like a template with a name dropped into it.
 */
async function generatePitch(ctx) {
  const ai = await ask(
    `${CREDENTIALS}

Write outreach for this opportunity. Indian business English, direct, no
flattery, no "I hope this email finds you well". Reference the company's actual
situation in the first line. Never invent metrics, case studies or client names.

${contextBlock(ctx)}

Return ONLY this JSON:
{
 "email":{"subject":"<max 8 words>","body":"<120-160 words, plain text, line breaks as \\n>"},
 "linkedin":"<max 60 words, connection-request tone>",
 "whatsapp":"<max 45 words, casual but professional>",
 "call_script":"<max 90 words: opener, one qualifying question, the ask>",
 "proposal_intro":"<max 70 words, opening paragraph of a formal proposal>"
}`
  );

  if (ai && ai.email && ai.email.body) {
    return {
      email: { subject: String(ai.email.subject || "").slice(0, 120), body: String(ai.email.body) },
      linkedin: String(ai.linkedin || ""),
      whatsapp: String(ai.whatsapp || ""),
      call_script: String(ai.call_script || ""),
      proposal_intro: String(ai.proposal_intro || ""),
      source: "ai",
    };
  }

  // Fallback: a real, sendable draft assembled from the playbook. Deliberately
  // plain — it is a starting point the salesperson will edit, and it is better
  // than an empty box.
  const company = ctx.company || "your team";
  const who = ctx.contact_name ? ctx.contact_name.split(" ")[0] : "there";
  const service = ctx.service || "creator-led distribution";
  const hook = ctx.signal_title
    ? `Saw the news about ${company} — ${ctx.signal_title}.`
    : `Been following what ${company} is building.`;

  return {
    email: {
      subject: `${company} × Curious Media`,
      body:
        `Hi ${who},\n\n${hook}\n\nWe run ${service.toLowerCase()} for consumer brands in India — creator ` +
        `campaigns and meme-page distribution that put a launch in front of an 18-34 audience at a ` +
        `fraction of paid media cost.\n\nWorth a 15-minute call this week to see whether it fits what ` +
        `${company} has planned?\n\nBest,\nCurious Media`,
    },
    linkedin: `Hi ${who} — ${hook} We run ${service.toLowerCase()} for consumer brands in India. Open to a quick chat about ${company}'s distribution plans?`,
    whatsapp: `Hi ${who}, this is Curious Media. ${hook} We handle creator and meme-page distribution for brands like yours — worth a short call?`,
    call_script:
      `Opener: "Hi ${who}, calling from Curious Media — ${hook.toLowerCase()}"\n` +
      `Qualify: "Who's handling creator and social distribution for that at the moment?"\n` +
      `Ask: "Can I send across a 2-page plan and take 15 minutes on Thursday?"`,
    proposal_intro:
      `Curious Media proposes a ${service.toLowerCase()} programme for ${company}, built to convert ` +
      `current momentum into measurable reach across India's creator and meme ecosystem.`,
    source: "rules",
  };
}

/* ── Items 11 & 17: reading what came back ────────────────────────────────── */

const INTENTS = ["interested", "information", "objection", "meeting", "rejection"];
const SENTIMENTS = ["positive", "neutral", "negative"];

/**
 * The brief calls this HUGE and it is right: the difference between "send the
 * deck" and "we already have an agency" is the difference between two entirely
 * different next moves, and left to a human it gets logged as "replied".
 *
 * Returns a next action written as an instruction, not a description.
 */
async function classifyReply(text, ctx = {}) {
  const ai = await ask(
    `${CREDENTIALS}

A prospect replied to our outreach. Classify it.

${contextBlock(ctx)}

Their reply:
"""${String(text).slice(0, 2000)}"""

Return ONLY this JSON:
{"sentiment":"positive|neutral|negative","intent":"interested|information|objection|meeting|rejection","next_action":"<one imperative sentence telling the salesperson what to do next, max 25 words>","stage_hint":"replied|meeting|proposal|negotiation|won|lost"}`
  );

  if (ai && INTENTS.includes(ai.intent) && SENTIMENTS.includes(ai.sentiment)) {
    return {
      sentiment: ai.sentiment,
      intent: ai.intent,
      next_action: String(ai.next_action || "").slice(0, 200),
      stage_hint: ai.stage_hint || null,
      source: "ai",
    };
  }

  return { ...classifyReplyByRules(text), source: "rules" };
}

/**
 * Keyword fallback. Ordered worst-first: a reply saying "not interested, we
 * already have an agency" is a rejection, not an objection, and checking
 * rejection first is what gets that right.
 */
function classifyReplyByRules(text) {
  const t = String(text || "").toLowerCase();
  const has = (...words) => words.some((w) => t.includes(w));

  if (has("not interested", "no thanks", "no thank you", "unsubscribe", "do not contact", "stop emailing")) {
    return {
      sentiment: "negative",
      intent: "rejection",
      next_action: "Mark lost and record why in the loss interview — do not send another follow-up.",
      stage_hint: "lost",
    };
  }
  if (has("already have an agency", "already working with", "existing partner", "too expensive", "budget", "no budget", "expensive", "costly")) {
    return {
      sentiment: "negative",
      intent: "objection",
      next_action: "Reposition as a specialist distribution partner alongside the incumbent, not a replacement for them.",
      stage_hint: "replied",
    };
  }
  if (has("call", "meeting", "meet", "calendar", "schedule", "connect on", "catch up")) {
    return {
      sentiment: "positive",
      intent: "meeting",
      next_action: "Send two concrete time slots today and add the meeting to this opportunity.",
      stage_hint: "meeting",
    };
  }
  if (has("send", "share", "deck", "proposal", "pricing", "details", "credentials", "case study")) {
    return {
      sentiment: "positive",
      intent: "interested",
      next_action: "Send credentials plus one relevant case study, then generate the proposal.",
      stage_hint: "proposal",
    };
  }
  if (has("who is", "what do you", "how does", "can you explain", "more info")) {
    return {
      sentiment: "neutral",
      intent: "information",
      next_action: "Answer the question in two lines and re-ask for 15 minutes.",
      stage_hint: "replied",
    };
  }
  return {
    sentiment: "neutral",
    intent: "information",
    next_action: "Read the reply and set the next action manually — the classifier could not call this one.",
    stage_hint: "replied",
  };
}

/* ── Item 19: follow-ups that differ from each other ──────────────────────── */

/**
 * The brief's rule: don't send the same message three times. Step 1 nudges,
 * step 2 adds value, step 3 changes the angle, step 4 stops selling and waits
 * for a new company signal.
 */
const FOLLOWUP_PLAN = [
  { step: 1, days: 3, kind: "reminder", brief: "A gentle two-line nudge. No new pitch, no pressure." },
  { step: 2, days: 7, kind: "value", brief: "Add value — lead with a relevant case study or a market observation." },
  { step: 3, days: 14, kind: "angle", brief: "Change the angle entirely — reference a recent company development." },
  { step: 4, days: 30, kind: "nurture", brief: "Stop selling. Move to nurture and wait for the next company signal." },
];

async function followupSuggestion(step, ctx = {}) {
  const plan = FOLLOWUP_PLAN.find((p) => p.step === step) || FOLLOWUP_PLAN[0];

  const ai = await ask(
    `${CREDENTIALS}

Write follow-up #${step} for this opportunity. ${plan.brief}
It must NOT repeat the wording of a standard "just following up" email.

${contextBlock(ctx)}

Return ONLY this JSON: {"subject":"<max 8 words>","body":"<max 90 words, plain text, \\n for line breaks>"}`
  );

  if (ai && ai.body) {
    return { subject: String(ai.subject || ""), body: String(ai.body), kind: plan.kind, source: "ai" };
  }

  const who = ctx.contact_name ? ctx.contact_name.split(" ")[0] : "there";
  const company = ctx.company || "your team";
  const bodies = {
    reminder: `Hi ${who},\n\nFloating this back to the top of your inbox in case it got buried. Still happy to walk through what we'd do for ${company} in 15 minutes.\n\nBest,\nCurious Media`,
    value: `Hi ${who},\n\nThought this might be more useful than another follow-up: we've run comparable creator campaigns in your category and can share what the reach-per-rupee actually looked like.\n\nWant me to send that across?\n\nBest,\nCurious Media`,
    angle: `Hi ${who},\n\nDifferent angle — we noticed what ${company} has been putting out recently. There's a distribution layer around that we could run without touching your existing agency's scope.\n\nWorth 15 minutes?\n\nBest,\nCurious Media`,
    nurture: `Hi ${who},\n\nI'll stop chasing. Keeping ${company} on our radar — when there's a launch or campaign where creator distribution would help, I'll come back with something specific.\n\nBest,\nCurious Media`,
  };

  return {
    subject: `${company} × Curious Media`,
    body: bodies[plan.kind],
    kind: plan.kind,
    source: "rules",
  };
}

/* ── Item 21: turning meeting notes into fields ───────────────────────────── */

const MEETING_OUTCOMES = [
  "interested",
  "need_proposal",
  "internal_discussion",
  "budget_discussion",
  "not_interested",
  "followup_later",
];

/**
 * The brief's point is that sales data gets lost in free-text meeting notes.
 * So the notes stay — they are the record — but the fields get extracted so
 * they can be counted later.
 */
async function structureMeetingNotes(notes, ctx = {}) {
  const ai = await ask(
    `Extract structured fields from these sales meeting notes.

${contextBlock(ctx)}

Notes:
"""${String(notes).slice(0, 3000)}"""

Return ONLY this JSON:
{"outcome":"${MEETING_OUTCOMES.join("|")}","requirement":"<what the client actually needs, max 30 words>","budget_mentioned":"<amount or null>","timeline":"<when they want it, or null>","decision_makers":["<name or role>"],"objections":["<short phrase>"],"next_step":"<one imperative sentence>"}`
  );

  if (ai && MEETING_OUTCOMES.includes(ai.outcome)) {
    return {
      outcome: ai.outcome,
      requirement: String(ai.requirement || "").slice(0, 300),
      budget_mentioned: ai.budget_mentioned || null,
      timeline: ai.timeline || null,
      decision_makers: Array.isArray(ai.decision_makers) ? ai.decision_makers.slice(0, 6) : [],
      objections: Array.isArray(ai.objections) ? ai.objections.slice(0, 6) : [],
      next_step: String(ai.next_step || "").slice(0, 200),
      source: "ai",
    };
  }

  return {
    outcome: null,
    requirement: "",
    budget_mentioned: null,
    timeline: null,
    decision_makers: [],
    objections: [],
    next_step: "",
    source: "rules",
  };
}

/* ── Item 22: the proposal draft ──────────────────────────────────────────── */

async function draftProposal(ctx) {
  const ai = await ask(
    `${CREDENTIALS}

Draft a short proposal. Indian business English. Never invent metrics, client
names or case study results — if you would need one, describe the shape of the
work instead.

${contextBlock(ctx)}
${ctx.deliverables ? `Deliverables: ${ctx.deliverables}` : ""}

Return ONLY this JSON:
{"title":"<max 10 words>","body":"<400-550 words of plain text with these sections, each on its own line prefixed by ## : Context, What we propose, Deliverables, Commercials, Why Curious Media, Next steps. Use \\n for line breaks.>"}`
  );

  if (ai && ai.body) {
    return { title: String(ai.title || "").slice(0, 160), body: String(ai.body), source: "ai" };
  }

  const price = ctx.price ? `INR ${Number(ctx.price).toLocaleString("en-IN")}` : "To be confirmed";
  return {
    title: `${ctx.company || "Client"} × Curious Media — ${ctx.service || "Proposal"}`,
    source: "rules",
    body:
      `## Context\n${ctx.signal_title || `${ctx.company || "The client"} is planning activity where creator-led distribution applies.`}\n\n` +
      `## What we propose\n${ctx.service || "A creator-led distribution programme"}${ctx.plan_name ? ` — ${ctx.plan_name}` : ""}.\n\n` +
      `## Deliverables\n${ctx.deliverables || "To be confirmed against the selected plan."}\n\n` +
      `## Commercials\n${price}\n\n` +
      `## Why Curious Media\nCreator campaigns, meme-page distribution and in-house UGC production, run end to end for consumer brands in India.\n\n` +
      `## Next steps\nConfirm scope and timelines, then we share the creator list and go live within two weeks of sign-off.`,
  };
}

module.exports = {
  recommendService,
  generatePitch,
  classifyReply,
  classifyReplyByRules,
  followupSuggestion,
  structureMeetingNotes,
  draftProposal,
  FOLLOWUP_PLAN,
  MEETING_OUTCOMES,
  SERVICES,
  INTENTS,
};
