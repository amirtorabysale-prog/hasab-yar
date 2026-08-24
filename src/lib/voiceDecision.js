const MIN_PARSER_CONFIDENCE = 0.82;
const MIN_REPORTED_SPEECH_CONFIDENCE = 0.45;

function recognitionReview(item) {
  return item?.reviewCode?.startsWith('candidate-') || Boolean(item?.alternatives?.length);
}

export function decideVoiceRoute(result, { online = true, transcriptFinal = false } = {}) {
  const transactions = Array.isArray(result?.transactions) ? result.transactions : [];
  const reasons = [];
  if (!transcriptFinal) reasons.push('transcript-not-final');
  if (!transactions.length) reasons.push('no-transaction');
  if (result?.candidateDisagreement || transactions.some(recognitionReview)) reasons.push('candidate-disagreement');
  if (transactions.some((item) => !Number.isSafeInteger(item.amount) || item.amount <= 0)) reasons.push('invalid-amount');
  if (transactions.some((item) => Number(item.confidence || 0) < MIN_PARSER_CONFIDENCE)) reasons.push('ambiguous-intent');
  const reportedSpeechConfidence = Number(result?.speechConfidence || 0);
  if (reportedSpeechConfidence > 0 && reportedSpeechConfidence < MIN_REPORTED_SPEECH_CONFIDENCE) reasons.push('low-speech-confidence');

  const recognitionReasons = reasons.filter((reason) => !['ambiguous-intent'].includes(reason));
  const score = Math.max(0, 100
    - (reasons.includes('candidate-disagreement') ? 45 : 0)
    - (reasons.includes('low-speech-confidence') ? 30 : 0)
    - (reasons.includes('transcript-not-final') ? 20 : 0)
    - (reasons.includes('ambiguous-intent') ? 15 : 0)
    - (reasons.includes('no-transaction') || reasons.includes('invalid-amount') ? 100 : 0));

  if (!transactions.length || reasons.includes('invalid-amount')) {
    return { route: online ? 'server' : 'unavailable', score, reasons };
  }
  if (!online && reasons.includes('transcript-not-final')) return { route: 'unavailable', score, reasons };
  if (online && recognitionReasons.length) return { route: 'server', score, reasons };
  if (reasons.length) return { route: 'local-review', score, reasons };
  return { route: 'local', score, reasons: [] };
}
