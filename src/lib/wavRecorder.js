const TARGET_SAMPLE_RATE = 16_000;

function mergeChunks(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function resamplePcm(samples, sourceRate, targetRate = TARGET_SAMPLE_RATE) {
  if (!samples.length || sourceRate === targetRate) return samples;
  if (targetRate > sourceRate) throw new Error('نرخ نمونه‌برداری خروجی نباید از ورودی بیشتر باشد.');
  const ratio = sourceRate / targetRate;
  const output = new Float32Array(Math.max(1, Math.round(samples.length / ratio)));
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((index + 1) * ratio)));
    let sum = 0;
    for (let sample = start; sample < end; sample += 1) sum += samples[sample];
    output[index] = sum / (end - start);
  }
  return output;
}

export function encodePcm16Wav(samples, sampleRate = TARGET_SAMPLE_RATE) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return buffer;
}

export function createWavRecorder(context, stream) {
  const source = context.createMediaStreamSource(stream);
  // بافر کوچک، انتهای جمله را هنگام برداشتن سریع انگشت قطع نمی‌کند.
  const processor = context.createScriptProcessor(1024, 1, 1);
  const silentOutput = context.createGain();
  silentOutput.gain.value = 0;
  const chunks = [];
  let sampleCount = 0;
  let squareSum = 0;
  let active = true;

  processor.onaudioprocess = (event) => {
    if (!active) return;
    const input = event.inputBuffer.getChannelData(0);
    const copy = new Float32Array(input);
    chunks.push(copy);
    sampleCount += copy.length;
    for (let index = 0; index < copy.length; index += 1) squareSum += copy[index] * copy[index];
  };
  source.connect(processor);
  processor.connect(silentOutput);
  silentOutput.connect(context.destination);

  const disconnect = () => {
    active = false;
    processor.onaudioprocess = null;
    try { source.disconnect(); } catch { /* already disconnected */ }
    try { processor.disconnect(); } catch { /* already disconnected */ }
    try { silentOutput.disconnect(); } catch { /* already disconnected */ }
  };

  return {
    source,
    stop() {
      if (!active) return null;
      disconnect();
      const durationMs = sampleCount ? Math.round((sampleCount / context.sampleRate) * 1000) : 0;
      const rms = sampleCount ? Math.sqrt(squareSum / sampleCount) : 0;
      const pcm = resamplePcm(mergeChunks(chunks), context.sampleRate, TARGET_SAMPLE_RATE);
      return {
        blob: new Blob([encodePcm16Wav(pcm)], { type: 'audio/wav' }),
        durationMs,
        rms,
        sampleRate: TARGET_SAMPLE_RATE,
      };
    },
    dispose: disconnect,
  };
}
