import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runChecks, extractNumbers, parseTranscript } from '../src/checks.js';

const calls = Object.fromEntries(
  JSON.parse(fs.readFileSync(new URL('../data/candidate-calls.json', import.meta.url))).map((c) => [c.id, c]),
);
const findings = JSON.parse(fs.readFileSync(new URL('../data/findings.json', import.meta.url))).calls;
const rules = (id, summary = calls[id].summary) => runChecks(calls[id].transcript, summary).map((r) => r.rule);

test('number words parse to amounts', () => {
  assert.deepEqual(extractNumbers('two hundred and twenty pounds'), [220]);
  assert.deepEqual(extractNumbers('seventeen hundred and sixty'), [1760]);
  assert.deepEqual(extractNumbers('seventy-five'), [75]);
  assert.ok(extractNumbers('Are you agreeing to pay one hundred pounds then?').includes(100));
});

test('transcripts parse into turns with ids', () => {
  for (const c of Object.values(calls)) {
    const turns = parseTranscript(c.transcript);
    assert.ok(turns.length > 10, c.id);
    assert.ok(turns.every((t) => /^T\d+$/.test(t.id)), c.id);
  }
});

test('every call has analyst findings and quotes match the summary text', () => {
  assert.equal(Object.keys(calls).length, 20);
  for (const id of Object.keys(calls)) {
    assert.ok(findings[id], `missing findings for ${id}`);
    for (const f of findings[id].findings) {
      if (f.quote) assert.ok(calls[id].summary.includes(f.quote), `${f.id} quote not in summary`);
      const turnIds = new Set(parseTranscript(calls[id].transcript).map((t) => t.id));
      f.evidence.forEach((t) => assert.ok(turnIds.has(t), `${f.id} cites unknown turn ${t}`));
    }
  }
});

test('automated checks flag known rule breaches and errors', () => {
  assert.ok(rules('CALL-003').includes('Arrears/balance figure'));
  assert.ok(rules('CALL-003').includes('Consent'));
  assert.ok(rules('CALL-016').includes('Immediate payment amount'));
  assert.ok(rules('CALL-019').includes('Call direction'));
  assert.ok(rules('CALL-019').includes('Consent'));
  assert.ok(rules('CALL-015').includes('Risk of further action'));
  assert.ok(rules('CALL-020').includes('Risk of further action'));
  assert.ok(rules('CALL-020').includes('Promise amount'));
  assert.ok(rules('CALL-002').includes('Promise amount'));
  assert.ok(rules('CALL-011').includes('Signposting'));
  assert.ok(rules('CALL-013').includes('Payment made unsupported'));
  assert.ok(rules('CALL-017').includes('Hold length'));
  assert.ok(rules('CALL-018').includes('Authority to Act'));
  assert.ok(rules('CALL-018').includes('I&E refusal'));
  assert.ok(rules('CALL-012').includes('Authority to Act scope'));
  assert.ok(rules('CALL-009').includes('I&E refusal'));
});

test('automated checks stay quiet on accurate summaries', () => {
  for (const id of ['CALL-001', 'CALL-004', 'CALL-005', 'CALL-006', 'CALL-007']) {
    assert.deepEqual(rules(id), [], id);
  }
});

test('suggested corrected summaries pass every automated check', () => {
  for (const [id, f] of Object.entries(findings)) {
    if (f.correctedSummary) assert.deepEqual(rules(id, f.correctedSummary), [], id);
  }
});

test('names, US spelling and filler are flagged', () => {
  const t = calls['CALL-001'].transcript;
  const r = runChecks(t, 'DPA completed. Jamie called the company and was authorized. Arrears not discussed.').map((x) => x.rule);
  assert.ok(r.includes('Anonymity'));
  assert.ok(r.includes('British English'));
  assert.ok(r.includes('Omission rule'));
});
