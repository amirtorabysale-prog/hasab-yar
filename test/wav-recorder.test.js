import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePcm16Wav, resamplePcm } from '../src/lib/wavRecorder.js';

test('encodes mono 16-bit PCM with a valid WAV header', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const buffer = encodePcm16Wav(samples, 16_000);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), 'WAVE');
  assert.equal(new TextDecoder().decode(bytes.slice(36, 40)), 'data');
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), samples.length * 2);
});

test('downsamples browser PCM to 16 kHz', () => {
  const source = new Float32Array(48_000).fill(0.25);
  const output = resamplePcm(source, 48_000, 16_000);
  assert.equal(output.length, 16_000);
  assert.ok(output.every((sample) => Math.abs(sample - 0.25) < 0.0001));
});
