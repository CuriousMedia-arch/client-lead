/**
 * Asks GitHub Actions to run a scan.
 *
 * A full cycle is ~90 API calls plus Gemini enrichment - minutes of work.
 * Vercel kills a function at 60s (Hobby), so the deployed app can't do the
 * scan itself. The workflow in .github/workflows/scan.yml does it instead,
 * writing straight to Supabase, and this is the "Run now" button's trigger.
 *
 * Needs GITHUB_TOKEN (a fine-grained PAT with Actions: read+write on the repo)
 * and GITHUB_REPO ("CuriousMedia-dash/Lead"). Without them the app falls back
 * to running in-process, which is what you want locally.
 */
const axios = require("axios");

const REPO = process.env.GITHUB_REPO || "";
const TOKEN = process.env.GITHUB_TOKEN || "";
const WORKFLOW = process.env.GITHUB_WORKFLOW_FILE || "scan.yml";
const BRANCH = process.env.GITHUB_BRANCH || "main";

function remoteRunConfigured() {
  return Boolean(REPO && TOKEN);
}

async function triggerRemoteRun() {
  if (!remoteRunConfigured()) throw new Error("Remote runs are not configured.");

  try {
    await axios.post(
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      { ref: BRANCH },
      {
        timeout: 10_000,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
  } catch (err) {
    const status = err.response && err.response.status;
    if (status === 404)
      throw new Error(
        `GitHub couldn't find ${WORKFLOW} on ${REPO}. Check GITHUB_REPO and that the workflow is on ${BRANCH}.`
      );
    if (status === 401 || status === 403)
      throw new Error("GitHub rejected the token. It needs Actions read+write on the repo.");
    throw new Error((err.response && err.response.data && err.response.data.message) || err.message);
  }
}

module.exports = { triggerRemoteRun, remoteRunConfigured };
