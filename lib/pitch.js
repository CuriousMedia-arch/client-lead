/**
 * The "what to pitch" line on a claimed lead.
 *
 * Derived from the strongest signal rather than stored, so it stays correct
 * when a newer, bigger signal arrives. Written as an angle a salesperson can
 * open with, not a description of the news they can already see above it.
 */
const TEMPLATES = {
  funding: (c) =>
    `${c} just raised — lead with work that helps them spend it fast and visibly: launch campaigns, brand refresh, category entry. Budget objections are weakest right now.`,
  m_and_a: (c) =>
    `${c} is mid-acquisition or restructure. Pitch as the steady hand while their own roster is in flux — brand consolidation, migrating comms, one voice across the merged entity.`,
  leadership: (c) =>
    `${c} has someone new in the chair. New leaders re-tender within months and want an early visible win — get in before the incumbent agency renegotiates.`,
  financials: (c) =>
    `${c} just reported. If revenue is up, pitch scale and share-of-voice; if it's down, lead with efficiency — better performance per rupee, not more spend.`,
  expansion: (c) =>
    `${c} is expanding. Pitch what makes the new market land: localised creative, regional media buying, launch-moment activation.`,
  launch: (c) =>
    `${c} is putting something new out. Pitch launch support — the campaign around it, the content engine behind it, the measurement after it.`,
  partnership: (c) =>
    `${c} has a new partnership to make noise about. Co-branded campaigns and announcement moments are an easy first project.`,
  other: (c) =>
    `No strong buying trigger for ${c} yet. Open with discovery rather than a pitch, and watch for the next signal.`,
};

function suggestPitch(company, signalType) {
  const fn = TEMPLATES[signalType] || TEMPLATES.other;
  return fn(company);
}

module.exports = { suggestPitch, TEMPLATES };
