// Deterministic rule checks derived from summary-rules.txt.
// Pure functions so they run both in the browser and under `node --test`.

const TURN_RE = /^(T\d+)\s+\[(\d\d:\d\d)\]\s+([^:]+):\s?(.*)$/;

export function parseTranscript(text) {
  return text.split('\n').map((line) => {
    const m = line.match(TURN_RE);
    if (!m) return { id: '?', time: '', speaker: 'Unknown', text: line };
    return { id: m[1], time: m[2], speaker: m[3].trim(), text: m[4] };
  });
}

export function isNonSpeech(turn) {
  return /^(Transcript note|Unclear speaker)$/i.test(turn.speaker);
}

// --- number words -> integers (enough for "two hundred and twenty") ---
const UNITS = {
  a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

export function extractNumbers(text) {
  const out = [];
  const tokens = text.toLowerCase().replace(/£/g, ' ').split(/[^a-z0-9]+/).filter(Boolean);
  let cur = null;
  const flush = () => { if (cur !== null) out.push(cur); cur = null; };
  for (const t of tokens) {
    if (/^\d+$/.test(t)) { flush(); out.push(Number(t)); continue; }
    if (t in UNITS || t in TENS) {
      const v = UNITS[t] ?? TENS[t];
      if (t === 'a') { flush(); cur = 1; continue; }
      if (cur === null) cur = v;
      else if (cur % 100 === 0) cur += v; // "two hundred" + "twenty"
      else if (cur % 10 === 0 && v < 10) cur += v; // "twenty" + "five"
      else { flush(); cur = v; }
      continue;
    }
    if (t === 'hundred' && cur !== null) { cur *= 100; continue; }
    if (t === 'thousand' && cur !== null) { cur *= 1000; continue; }
    if (t === 'and' && cur !== null && cur >= 100) continue;
    flush();
  }
  flush();
  return out;
}

const US_SPELLINGS = [
  'authorized', 'authorize', 'authorization', 'center', 'program', 'color', 'behavior', 'favor',
  'organization', 'realize', 'recognize', 'apologize', 'canceled', 'canceling', 'analyze',
  'defense', 'counseling', 'judgment', 'prioritize', 'utilize', 'finalize', 'labor',
];

function splitSentences(s) {
  return s.trim().split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean);
}

function directionFromTranscript(turns) {
  const first = turns.find((t) => !isNonSpeech(t));
  if (!first) return null;
  if (/^agent/i.test(first.speaker)) {
    if (/(could|can|may) I (speak|talk) to/i.test(first.text)) return { dir: 'outbound', turn: first.id };
    return { dir: 'inbound', turn: first.id };
  }
  return { dir: 'inbound', turn: first.id };
}

function customerNames(turns) {
  const names = new Set();
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const m = t.text.match(/(?:speak|talk) to ([A-Z][a-z]+(?: [A-Z][a-z]+)+)/);
    if (m) m[1].split(' ').forEach((n) => names.add(n));
    const a = t.text.match(/(?:speaking with|my name's|my name is) ([A-Z][a-z]+)/);
    if (a && /^agent/i.test(t.speaker)) names.add(a[1]);
    if (/^agent/i.test(t.speaker) && /full name/i.test(t.text) && turns[i + 1]) {
      const c = turns[i + 1].text.match(/^([A-Z][a-z]+(?: [A-Z][a-z]+)+)/);
      if (c) c[1].split(' ').forEach((n) => names.add(n));
    }
  }
  return [...names].filter((n) => n.length > 2);
}

function consentStatus(turns) {
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!/^agent/i.test(t.speaker)) continue;
    if (!/(happy|comfortable|okay|ok)\b.{0,40}\b(record|note)/i.test(t.text)) continue;
    const reply = turns.slice(i + 1).find((r) => /^customer/i.test(r.speaker));
    if (!reply) continue;
    if (/^(yes|yeah|aye|ok|okay|that's fine)|you can (record|note|write)/i.test(reply.text)) return { status: 'gained', turns: [t.id, reply.id] };
    if (/(rather you didn't|don't want|do not want|^no\b)/i.test(reply.text)) return { status: 'refused', turns: [t.id, reply.id] };
  }
  return null;
}

function ieDeclined(turns) {
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (/^agent/i.test(t.speaker) && /you've declined (that|the assessment)/i.test(t.text)) return [t.id];
    if (/^agent/i.test(t.speaker) && /income and expenditure/i.test(t.text)) {
      const reply = turns[i + 1];
      if (reply && /^customer/i.test(reply.speaker) && /^(no\b|i'd rather not)/i.test(reply.text)) return [t.id, reply.id];
    }
  }
  return null;
}

const agentTurns = (turns) => turns.filter((t) => /^agent/i.test(t.speaker));
const findAgent = (turns, re) => agentTurns(turns).filter((t) => re.test(t.text)).map((t) => t.id);

/**
 * Run all checks on a summary against its transcript.
 * Returns [{ rule, severity, message, evidence: [turnIds], quote }]
 */
export function runChecks(transcriptText, summary) {
  const turns = parseTranscript(transcriptText);
  const results = [];
  const add = (rule, severity, message, evidence = [], quote = null) =>
    results.push({ rule, severity, message, evidence, quote });

  // Gatekeeper outcomes have fixed wording; skip the rest.
  if (/^(Incomplete call\.|Voicemail )/.test(summary.trim())) return results;

  // 1. Arrears / balance figures
  const arrearsFig = summary.match(/(arrears|balance)\s+(of|totalling|at|is)\s+£[\d,.]+|£[\d,.]+\s+(of\s+)?(arrears|balance)/i);
  if (arrearsFig) add('Arrears/balance figure', 'medium', 'Specific arrears or balance figures must not be included.', [], arrearsFig[0]);

  // 2. Amount on an immediate payment
  const payAmt = summary.match(/payment of £[\d,.]+ (was )?(made|taken)|£[\d,.]+ (payment )?(was )?(made|taken) (today|during)/i);
  if (payAmt) add('Immediate payment amount', 'medium', "Payments taken during the call must be written as 'Payment made' with no amount.", [], payAmt[0]);

  // 3. "Payment made" without a successful payment in the transcript
  const paySuccess = findAgent(turns, /(been successful|gone through successfully|payment has gone through|payment has been successful)/i);
  if (/payment made/i.test(summary) && paySuccess.length === 0) {
    add('Payment made unsupported', 'high', "Summary says 'Payment made' but no successful payment is confirmed by the agent.", [], summary.match(/payment made/i)[0]);
  }

  // 4. Call direction
  const dir = directionFromTranscript(turns);
  const saysInbound = /customer (called|contacted|phoned|rang) the company/i.test(summary);
  const saysOutbound = /company (called|contacted|phoned|rang)/i.test(summary);
  if (dir && dir.dir === 'outbound' && saysInbound)
    add('Call direction', 'high', 'Agent opened by asking for a named person (outbound), but summary says the customer called.', [dir.turn], summary.match(/customer (called|contacted|phoned|rang) the company/i)[0]);
  if (dir && dir.dir === 'inbound' && saysOutbound)
    add('Call direction', 'high', 'Agent opened with a service greeting (inbound), but summary says the company called.', [dir.turn], summary.match(/company (called|contacted|phoned|rang)/i)[0]);

  // 5. DPA status
  const dpaTurns = findAgent(turns, /(security is complete|details are verified|those match|pre-call security is confirmed|those details are verified)/i);
  if (/^DPA completed/i.test(summary) && dpaTurns.length === 0)
    add('DPA status', 'high', "Summary says 'DPA completed' but no full verification or pre-call security is confirmed.", [], 'DPA completed');
  if (/no DPA stated with agent/i.test(summary) && dpaTurns.length > 0)
    add('DPA status', 'medium', "Summary says 'no DPA stated with agent' but the agent confirmed security.", dpaTurns, summary.match(/no DPA stated with agent/i)[0]);
  if (!/DPA completed|no DPA stated with agent/i.test(summary))
    add('DPA status', 'medium', 'DPA status statement is missing.', dpaTurns);

  // 6. Risk of further action
  const riskTurns = findAgent(turns, /risk of further action/i);
  if (riskTurns.length && !/risk of further action/i.test(summary))
    add('Risk of further action', 'medium', "Agent warned of risk of further action; summary must use the phrase 'risk of further action'.", riskTurns);
  const furtherCount = (summary.match(/further action/gi) || []).length - (summary.match(/risk of further action/gi) || []).length;
  if (furtherCount > 0) add('Terminology', 'low', "'Further action' must not describe the plan; use 'next steps'.", [], 'further action');

  // 7. Signposting
  const webTurns = findAgent(turns, /(company website|our website|support page)/i);
  if (webTurns.length && !/customer signposted/i.test(summary))
    add('Signposting', 'medium', "Agent pointed the customer to the website; summary must include 'customer signposted'.", webTurns);

  // 8. Consent
  const consent = consentStatus(turns);
  const saysConsent = /consent gained to record vulnerability/i.test(summary);
  if (consent && consent.status === 'gained' && !saysConsent)
    add('Consent', 'medium', "Customer agreed to recording; summary must include 'Consent gained to record vulnerability'.", consent.turns);
  if (consent && consent.status === 'refused' && saysConsent)
    add('Consent', 'high', 'Summary records consent, but the customer declined recording.', consent.turns, summary.match(/consent gained to record vulnerability/i)[0]);
  if (!consent && saysConsent)
    add('Consent', 'medium', 'Summary records consent, but no consent exchange was detected.', [], summary.match(/consent gained to record vulnerability/i)[0]);

  // 9. Authority to Act
  const ataRefused = findAgent(turns, /(can't|cannot) discuss .* without (her|his|their) authority|no authority to act has been granted/i);
  const ataThisCall = findAgent(turns, /(for this call only|permission for this call only)/i);
  if (ataRefused.length && /authority to act (was |has been )?(verified|granted|confirmed)/i.test(summary))
    add('Authority to Act', 'high', 'Summary says Authority to Act was verified, but the agent refused due to lack of authority.', ataRefused, summary.match(/authority to act (was |has been )?(verified|granted|confirmed)/i)[0]);
  if (ataThisCall.length && /(ongoing|permanent|future calls)/i.test(summary))
    add('Authority to Act scope', 'high', 'Authority to Act was for this call only, but summary implies it continues.', ataThisCall, summary.match(/(ongoing|permanent|future calls)/i)[0]);

  // 10. Hold length
  const holdT = agentTurns(turns).map((t) => [t.id, t.text.match(/\b([a-z]+|\d+)-day (?:contact )?hold/i)]).filter(([, m]) => m);
  const holdS = summary.match(/\b([a-z]+|\d+)-day hold/i);
  if (holdS) {
    const transcriptLens = holdT.map(([, m]) => m[1].toLowerCase());
    if (transcriptLens.length && !transcriptLens.includes(holdS[1].toLowerCase()))
      add('Hold length', 'high', `Summary says a ${holdS[1]}-day hold; transcript says ${[...new Set(transcriptLens)].join('/')}-day.`, holdT.map(([id]) => id), holdS[0]);
  }

  // 11. I&E refusal
  const declined = ieDeclined(turns);
  const saysRefusedIE = /(refused|declined)\s+(an |the )?I&E/i.test(summary);
  if (declined && !saysRefusedIE)
    add('I&E refusal', 'medium', 'Customer declined an I&E assessment; the summary must state this.', declined);
  if (!declined && saysRefusedIE)
    add('I&E refusal', 'high', 'Summary says the I&E was refused, but no refusal was detected (it may have been deferred).', findAgent(turns, /income and expenditure/i), summary.match(/(refused|declined)\s+(an |the )?I&E/i)[0]);

  // 12. Promise amounts must appear in an agent turn that isn't explicitly "not a promise"
  const promiseRe = /agreed to pay £([\d,]+)/gi;
  let pm;
  while ((pm = promiseRe.exec(summary))) {
    const amt = Number(pm[1].replace(/,/g, ''));
    const confirming = agentTurns(turns).filter((t) => extractNumbers(t.text).includes(amt) && !/(won't|will not|not) record .* promise|won't record/i.test(t.text));
    if (!confirming.length) {
      const mentions = turns.filter((t) => extractNumbers(t.text).includes(amt)).map((t) => t.id);
      add('Promise amount', 'high', `Summary records a £${amt} promise that the agent never confirmed as agreed.`, mentions, pm[0]);
    }
  }

  // 13. Names
  for (const n of customerNames(turns)) {
    const re = new RegExp(`\\b${n}\\b`);
    if (re.test(summary)) add('Anonymity', 'medium', `Name '${n}' appears in the summary.`, [], n);
  }

  // 14. British English
  for (const w of US_SPELLINGS) {
    const re = new RegExp(`\\b${w}\\b`, 'i');
    const m = summary.match(re);
    if (m) add('British English', 'low', `US spelling '${m[0]}'.`, [], m[0]);
  }

  // 15. Format
  const n = splitSentences(summary).length;
  if (n < 2 || n > 5) add('Length', 'low', `Summary has ${n} sentences; rules require 2–5.`);
  if (/^\s*[-•*]\s/m.test(summary)) add('Format', 'low', 'Bullet points are not allowed.');
  const filler = summary.match(/\b(N\/A|not discussed|not completed)\b/i);
  if (filler) add('Omission rule', 'low', `Filler '${filler[0]}' breaks the omission rule.`, [], filler[0]);

  return results;
}
