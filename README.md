# Call Summary Review

A review tool for QA reviewers. For each collections-call summary it helps decide whether the summary faithfully represents its transcript, and whether it needs correcting before a colleague relies on it.

**Live app:** _LIVE_URL_ (no login needed)

## How to run

The app is a static site with no dependencies and no build step.

```bash
npm start        # serves at http://localhost:5173 (Node 18+)
npm test         # runs the rule-check tests (node --test)
```

Any static file server also works. Opening `index.html` directly from disk does not, because the browser blocks `fetch` of the data files.

## How to use it

1. **Queue (left).** Shows all 20 calls, with severity counts and your review status. Filter by *Flagged*, *Unreviewed* or *Reviewed*.
2. **Summary (centre).** Claims with a finding are highlighted. Click one, or its finding card, to highlight the supporting transcript turns on the right. Turn-ID chips (`T14`) scroll to the turn.
3. **Findings.** Each card shows:
   - the **type**: contradiction, unsupported, omission or rule breach;
   - the **severity**: high, medium or low;
   - the **certainty**: definite, or uncertain (a judgement call);
   - the quoted claim, an explanation, the evidence turns and a suggested fix.

   Mark each finding *Agree* or *Disagree*. Accurate summaries show what was checked, so the reviewer can see *why* the summary passed.
4. **Rule checks (automated).** Deterministic checks of `summary-rules.txt`, run live in the browser.
5. **Decision.** Choose *Accept summary* or *Needs correction*. The corrected-summary box is prefilled with a suggested correction, and the rule checks re-run on it as you type. Add a reviewer note if needed.
6. **Export.** Decisions download as JSON or CSV for hand-off. Progress is saved in this browser only (localStorage).

Keyboard: `j`/`k` move to the next/previous call, `a` accepts, `c` marks *needs correction*.

## What I prioritised and why

- **Helping the reviewer separate "misleading" from "imperfect".** Severity is defined by whether the summary could mislead a colleague acting on it. High means a wrong promise, payment, permission or consent, hold length or call direction. Medium means missing compliance, hardship or cause information, or a privacy or money-rule breach. Low means wording precision. Certainty is shown separately so that judgement calls are not presented as errors.
- **Evidence first.** Every finding cites call-local turn IDs and is one click from the transcript. That keeps the transcript as the single reference.
- **Two independent layers of analysis.**
  - **Analyst findings** (`data/findings.json`): a careful per-call review of all 20 calls against the rules and the readme guidance. It covers meaning-level problems that regexes cannot judge.
  - **Automated rule checks** (`src/checks.js`): 15 transparent checks. They cover arrears and payment figures, unsupported "Payment made", call direction, DPA status, risk-of-further-action and signposting phrases, consent given or refused, Authority-to-Act status and scope, hold-length mismatch, I&E refusal, promise amounts, names, US spellings, length and format. They catch 14 of the 15 calls the analyst flagged, raise no flags on the 5 accurate calls, and validate corrected summaries live.
- **A complete loop over a wide feature set.** Review, decide, correct, re-check and export all work end to end.

## Results from this dataset

- **Accurate (5):** 001, 004, 005, 006, 007.
- **Need correction (15).** The highest-risk cases:
  - 002: promise is £150 but £100 was agreed.
  - 013: "Payment made" although nothing was taken.
  - 020: records an £80 promise the customer explicitly refused.
  - 018: says the partner's Authority to Act was verified, but it was refused.
  - 012: says Authority to Act is ongoing, but it was for this call only.
  - 003: says consent was gained, but it was refused.
  - 017: says a 30-day hold, but it was 14 days, and the bereavement is omitted.
  - 019: says inbound, but the call was outbound.
  - 009: says the I&E was refused, but it was deferred.
  - 008: claims a default notice that was never mentioned.

## Material assumptions

- The transcript is the only reference. Out-of-context hold-music text (CALL-003 T15) is an ASR hallucination and is ignored, as the rules require.
- The analyst findings are pre-computed for this fixed set of 20 calls. I chose not to call an LLM at runtime, to avoid shipping API keys, cost and latency, and to keep the results reproducible within 90 minutes. The automated checks are the part that generalises to new summaries.
- DPA follows the readme exception. Name and postcode alone (CALL-014) gives "No DPA stated with agent". Pre-call security confirmed by the agent (CALL-010) counts as completed.
- An agent asking "can you pay anything today?" and being declined counts as a payment attempt, consistent with how CALL-002 is summarised. This is marked *uncertain* where it matters (009, 013).
- One reviewer per browser. There is no authentication or shared state; the export is the hand-off.

## What I checked

- `npm test` (7 tests):
  - all 20 transcripts parse;
  - every analyst quote appears verbatim in its summary, and every cited turn exists;
  - the automated checks fire on the known errors and stay silent on the 5 accurate calls;
  - every suggested corrected summary passes all automated checks;
  - number words parse correctly ("two hundred and twenty" becomes 220).
- A manual pass through the UI: navigation, evidence scrolling, verdicts persisting after a reload, the corrected-summary re-check, and JSON/CSV export.

## Known limitations

- The analyst findings cover only these 20 calls. A new call would get the automated checks alone.
- The automated checks are pattern-based on this dataset's phrasing. They will miss paraphrased errors, can over-flag, and cannot detect missing hardship detail or unsupported claims such as 008's default notice.
- Review state lives in localStorage, so it is per device and has no audit trail or multi-reviewer reconciliation.
- Gatekeeper cases (voicemail, internal calls, incomplete calls) are handled only minimally, because none appear in the data.

## What I would tackle next

1. An LLM review pass behind a small server-side API (key kept server-side) that produces the same findings schema for new calls. I would evaluate it against `data/findings.json` as a labelled set, measuring precision and recall per finding type, and keep the automated checks as guardrails.
2. Shared persistence with reviewer identity, an audit trail and a second-reviewer flow for disagreements.
3. Aggregate reporting by error type across calls, to feed back into the summary-generation prompt (e.g. "Consent" and "Authority to Act" errors recur).
4. Inline diffs between the original and corrected summary.

## Structure

```
index.html, styles.css    UI shell
src/app.js                review workflow, rendering, persistence, export
src/checks.js             deterministic rule checks (shared by the browser and the tests)
data/candidate-calls.json supplied calls (unchanged)
data/findings.json        analyst findings, suggested verdicts and corrections
data/summary-rules.txt, data/candidate-readme.md   supplied reference
tests/checks.test.mjs     node:test suite
serve.mjs                 zero-dependency local server
```
