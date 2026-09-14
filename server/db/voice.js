import { randomUUID } from 'node:crypto';
import { db } from './core.js';

export function recordVoiceMetric(values = {}) {
  db.prepare(`INSERT INTO voice_metrics (id,provider,model,duration_ms,first_transcript_ms,latency_ms,transaction_count,needs_review,succeeded,error_code)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), String(values.provider || 'unknown').slice(0, 40), String(values.model || '').slice(0, 100), Math.max(0, Number(values.durationMs) || 0), Math.max(0, Number(values.firstTranscriptMs) || 0), Math.max(0, Number(values.latencyMs) || 0), Math.max(0, Number(values.transactionCount) || 0), values.needsReview ? 1 : 0, values.succeeded === false ? 0 : 1, String(values.errorCode || '').slice(0, 80));
}

export function voiceStats() {
  const totals = db.prepare(`SELECT COUNT(*) AS total,SUM(succeeded) AS succeeded,
    ROUND(AVG(CASE WHEN succeeded=1 THEN latency_ms END)) AS averageLatency,
    ROUND(AVG(CASE WHEN first_transcript_ms>0 THEN first_transcript_ms END)) AS averageFirstTranscript,
    SUM(needs_review) AS reviewed,
    SUM(CASE WHEN provider IN ('browser-live','openai-realtime') THEN 1 ELSE 0 END) AS fastPath,
    ROUND(100.0*SUM(CASE WHEN provider IN ('browser-live','openai-realtime') THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS fastPathRate
    FROM voice_metrics`).get();
  const providers = db.prepare(`SELECT provider,model,COUNT(*) AS count,ROUND(AVG(latency_ms)) AS averageLatency,
    ROUND(100.0*SUM(succeeded)/COUNT(*),1) AS successRate FROM voice_metrics GROUP BY provider,model ORDER BY count DESC`).all();
  return { ...totals, providers };
}
