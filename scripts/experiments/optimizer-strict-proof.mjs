// Node coordinator only. Every request invokes the same exact producer and
// separate checker. A HiGHS status, score, or gap is never a proof credential.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const directory = fileURLToPath(new URL('./', import.meta.url));

export function certifyOptimization(input, candidate, { timeoutMs = 30000, maxNodes = 1000000, outputPrefix, retainArtifacts = true } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || !Number.isSafeInteger(maxNodes) || maxNodes < 0)
    throw Error('Invalid strict-proof budget');
  const started = performance.now();
  const temporary = outputPrefix ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), 'optimizer-strict-proof-'));
  const prefix = outputPrefix ?? path.join(temporary, 'result');
  const files = { input: prefix + '.input.json', candidate: prefix + '.candidate.json', certificate: prefix + '.certificate.json', verification: prefix + '.verification.json' };
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  const inputBytes = JSON.stringify(input);
  const inputDigest = createHash('sha256').update(inputBytes).digest('hex');
  fs.writeFileSync(files.input, inputBytes);fs.writeFileSync(files.candidate, JSON.stringify(candidate ?? null));
  const unproven = reason => ({ status: 'unproven', proofVerified: false, reason, totalProofMs: performance.now() - started, artifacts: outputPrefix || retainArtifacts ? files : undefined });
  try {
    for (const file of [files.certificate, files.verification]) if (fs.existsSync(file)) fs.unlinkSync(file);
    if (Buffer.byteLength(inputBytes) > 64 * 1024 * 1024) return unproven('Input exceeds64MiB limit');
    const producer = spawnSync('python', [path.join(directory, 'optimizer-proof-producer.py'), '--input', files.input,
      '--candidate', files.candidate, '--output', files.certificate, '--seconds', String(timeoutMs / 1000), '--nodes', String(maxNodes)],
    { encoding: 'utf8', timeout: timeoutMs + 10000, maxBuffer: 1024 * 1024 });
    if (producer.status !== 0 || !fs.existsSync(files.certificate)) return unproven('Proof generation did not complete: ' + (producer.error?.message ?? producer.stderr.slice(-1000)));
    if (fs.statSync(files.certificate).size > 64 * 1024 * 1024) return unproven('Certificate exceeds64MiB limit');
    const certificateBytes = fs.readFileSync(files.certificate);
    const certificateDigest = createHash('sha256').update(certificateBytes).digest('hex');
    const certificate = JSON.parse(certificateBytes);
    // Even incomplete producer outputs go through the independent checker;
    // its first rule rejects them. The coordinator never grants certification.
    const checker = spawnSync('python', [path.join(directory, 'optimizer-proof-checker.py'), '--input', files.input,
      '--proof', files.certificate, '--output', files.verification, '--seconds', String(timeoutMs / 1000), '--nodes', String(maxNodes * 2)],
    { encoding: 'utf8', timeout: timeoutMs + 10000, maxBuffer: 1024 * 1024 });
    if (checker.status !== 0 || !fs.existsSync(files.verification)) return unproven('Independent proof checking did not complete: ' + (checker.error?.message ?? checker.stderr.slice(-1000)));
    const verified = JSON.parse(fs.readFileSync(files.verification));
    if (verified.proofVerified !== true) return unproven(certificate.complete ? verified.reason ?? 'Independent checking failed' : certificate.reason ?? verified.reason);
    if (!['certified-optimal', 'certified-infeasible'].includes(verified.status) || verified.inputFileSha256 !== inputDigest || verified.certificateFileSha256 !== certificateDigest || verified.inputHash !== certificate.inputHash || verified.version !== certificate.version) return unproven('Independent report is not bound to this request/certificate');
    return { ...verified, reason: certificate.complete ? verified.reason : certificate.reason ?? verified.reason,
      generationMs: certificate.generationMs, totalProofMs: performance.now() - started, artifacts: outputPrefix || retainArtifacts ? files : undefined };
  } catch (error) {
    return unproven('Strict proof pipeline failed: ' + String(error));
  } finally {
    if (temporary && !retainArtifacts) fs.rmSync(temporary, { recursive: true, force: true });
  }
}
