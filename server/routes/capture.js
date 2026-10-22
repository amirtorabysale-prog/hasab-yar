// ثبت گفته و متن: پارس، صدا و تراکنش.
//
// از server/index.js جدا شد؛ بدنهٔ مسیرها دست نخورده و ترتیب ثبتشان همان ترتیب قبلی است.
// احراز هویت، CSRF و مرز نقش و تجربه پیش از این‌ها در index.js اعمال می‌شود.

import express from 'express';
import { queueUnquantifiedReview } from '../db/reviewIntakes.js';
import { queueUnmatchedSettlement } from '../db/transactions.js';
import {
  beginProviderUsage, deleteTransaction, finishProviderUsage, getCategories, getLearnings, correctLatestTransaction, findPotentialDuplicates, getToday, getTransaction, previewTransactions, insertTransactions, queueCompositeUtterance, latestTransaction, listAccounts, listTransactions, dnaProfiles, recordRealtimeProviderDuration, recordVoiceMetric, legacySnapshot, redoTransaction, typicalAmounts, updateTransaction, voiceStats,
} from '../db.js';
import { parseFinancialText } from '../parser.js';
import { previewCorrection } from '../../shared/correction.js';
import { applyDnaSignals } from '../../shared/dnaSignals.js';
import { parseFinancialAudio } from '../voice.js';
import { createRealtimeTranscriptionCall } from '../openaiRealtime.js';
import { voiceProviderStatus } from '../voiceProviderState.js';
import { audioDurationMs } from '../collaboration.js';
import { setTransactionTopicLabel } from '../topicPromotion.js';
import { shadowUnderstanding, upload } from './http.js';

export function registerCaptureRoutes(app) {
  app.post('/api/parse/text', (request, response) => {
    const text = String(request.body?.text || '').trim();
    if (!text || text.length > 1500) return response.status(400).json({ message: 'متن ثبت مالی معتبر نیست.' });
    // برداشت با الگوی خودِ پرونده سنجیده می‌شود؛ چیزی رد یا ثبت نمی‌شود، فقط به صف بررسی می‌رود.
    return response.json(applyDnaSignals(parseFinancialText(text, { learnings: getLearnings(), averages: typicalAmounts() }), dnaProfiles()));
  });
  app.post('/api/parse/audio', upload.single('audio'), async (request, response, next) => {
    const startedAt = Date.now();
    let usageId = null;
    let durationMs = 0;
    try {
      if (!request.file) return response.status(400).json({ message: 'فایل صدا دریافت نشد.' });
      durationMs = audioDurationMs(request.file.buffer, request.file.mimetype) || Math.min(60_000, Math.max(0, Number(request.body?.durationMs) || 0));
      usageId = beginProviderUsage('server_voice', 'pipeline', { attemptId: request.body?.attemptId || request.get('x-voice-attempt') || '' });
      const parsed = await parseFinancialAudio({ buffer: request.file.buffer, mimeType: request.file.mimetype || 'application/octet-stream', hint: request.body?.hint, durationMs, categories: getCategories(), learnings: getLearnings(), averages: typicalAmounts() });
      const result = applyDnaSignals(parsed, dnaProfiles());
      recordVoiceMetric({
        provider: result.provider || result.engine,
        model: result.model,
        durationMs,
        latencyMs: Date.now() - startedAt,
        transactionCount: result.transactions?.length,
        needsReview: result.transactions?.some((item) => item.needsReview),
        errorCode: request.body?.fallbackReason,
      });
      finishProviderUsage(usageId, { provider: result.provider || result.engine, durationMs });
      return response.json(result);
    } catch (error) {
      if (usageId) finishProviderUsage(usageId, { provider: error.provider || 'pipeline', durationMs, succeeded: false, errorCode: error.code });
      if (!['PLAN_QUOTA_EXCEEDED', 'PROVIDER_BUDGET_EXCEEDED'].includes(error.code)) recordVoiceMetric({ provider: 'pipeline', durationMs, latencyMs: Date.now() - startedAt, succeeded: false, errorCode: error.code });
      return next(error);
    }
  });
  app.post('/api/voice/realtime/session', express.text({ type: ['application/sdp', 'text/plain'], limit: '128kb' }), async (request, response, next) => {
    let usageId = null;
    try {
      // شناسهٔ تلاش از کلاینت می‌آید تا نشست realtime و بررسی فایلِ همان ضبط، یک
      // واحد سهمیه شمرده شوند، نه دو تا.
      usageId = beginProviderUsage('realtime_session', 'openai', { attemptId: request.get('x-voice-attempt') || '' });
      const answer = await createRealtimeTranscriptionCall({
        sdp: request.body,
        categories: getCategories(),
        learnings: getLearnings(),
        userId: request.user.id,
      });
      finishProviderUsage(usageId, { provider: 'openai' });
      return response.type('application/sdp').send(answer);
    } catch (error) {
      if (usageId) finishProviderUsage(usageId, { provider: 'openai', succeeded: false, errorCode: error.code });
      return next(error);
    }
  });
  app.post('/api/transactions/preview', (request, response, next) => {
    try { return response.json({ previews: previewTransactions(request.body) }); } catch (error) { return next(error); }
  });
  app.post('/api/transactions', (request, response, next) => {
    try {
      const transactions = request.body?.transactions;
      if (!Array.isArray(transactions) || !transactions.length || transactions.length > 20) return response.status(400).json({ message: 'حداقل یک تراکنش معتبر لازم است.' });
      if (!request.body?.allowDuplicates && request.get('x-allow-duplicate') !== '1') {
        const duplicates = findPotentialDuplicates(transactions);
        if (duplicates.length) {
          const message = duplicates[0].reason === 'recent' ? 'یک ثبت بسیار مشابه در چند دقیقهٔ اخیر پیدا شد.'
            : 'یک ثبت با همین مبلغ و همین دسته در همین دوره هست؛ شاید این تکراری باشد.';
          throw Object.assign(new Error(message), { code: 'POSSIBLE_DUPLICATE', status: 409, details: { duplicates } });
        }
      }
      const ids = insertTransactions({ transcript: request.body.transcript, transactions, counterpartyResolution: request.body.counterpartyResolution });
      shadowUnderstanding(request.body.transcript, transactions[0]?.source, () => legacySnapshot('transactions', { ids, queued: ids.queuedForAccountant }), transactions[0]?.clientId);
      return response.status(201).json({ ids, queuedForAccountant: ids.queuedForAccountant || 0, queuedReasons: ids.queuedReasons || [], nonCash: ids.nonCash || [], ...getToday() });
    } catch (error) { return next(error); }
  });
  app.post('/api/transactions/unquantified-review', (request, response, next) => {
    try {
      const item = queueUnquantifiedReview(request.body?.transcript, request.body || {});
      shadowUnderstanding(request.body?.transcript, request.body?.source, () => legacySnapshot('unquantified-review'), request.body?.clientId);
      return response.status(201).json({ item });
    }
    catch (error) { return next(error); }
  });
  app.post('/api/transactions/unmatched-settlement-review', (request,response,next)=>{
    try {return response.status(201).json({item:queueUnmatchedSettlement(request.body?.transcript,request.body || {})});}
    catch(error){return next(error);}
  });
  app.post('/api/transactions/composite-review', (request, response, next) => {
    try {
      const item = queueCompositeUtterance(request.body?.transcript, {
        clientId: request.body?.clientId, source: request.body?.source,
      });
      shadowUnderstanding(request.body?.transcript, request.body?.source, () => legacySnapshot('composite-review', { queued: 1 }), request.body?.clientId);
      return response.status(201).json({ item });
    } catch (error) { return next(error); }
  });
  app.post('/api/transactions/:id/topic-label', (request, response, next) => {
    try { return response.json({ item: setTransactionTopicLabel(request.params.id, request.body?.label || '') }); } catch (error) { return next(error); }
  });
  app.get('/api/transactions', (request, response) => response.json(listTransactions(request.query)));
  app.get('/api/transactions/latest', (_request, response) => response.json({ item: latestTransaction() }));
  app.put('/api/transactions/:id', (request, response, next) => { try { const item = updateTransaction(request.params.id, request.body); return item ? response.json({ item }) : response.status(404).json({ message: 'تراکنش پیدا نشد.' }); } catch (error) { return next(error); } });
  app.post('/api/transactions/:id/correct', (request, response, next) => {
    try {
      const current = getTransaction(request.params.id);
      if (!current) return response.status(404).json({ code: 'TRANSACTION_NOT_FOUND', message: 'تراکنش پیدا نشد.' });
      const command = String(request.body?.command || '').trim().slice(0, 500);
      const interpretation = previewCorrection(command, current, { learnings: getLearnings(), accounts: listAccounts(), categories: getCategories() });
      if (!interpretation.canApply) return response.status(400).json({ code: 'CORRECTION_NOT_UNDERSTOOD', message: interpretation.explanation });
      const item = correctLatestTransaction(request.params.id, command, interpretation.changes);
      return response.json({ item, interpretation });
    } catch (error) { return next(error); }
  });
  app.post('/api/transactions/:id/redo', (request, response, next) => { try { return response.status(201).json({ item: redoTransaction(request.params.id) }); } catch (error) { return next(error); } });
  app.delete('/api/transactions/:id', (request, response, next) => { try { return response.status(deleteTransaction(request.params.id) ? 204 : 404).end(); } catch (error) { return next(error); } });
  app.post('/api/voice/metrics', (request, response) => {
    const provider = String(request.body?.provider || '');
    if (!['browser-live', 'openai-realtime'].includes(provider)) return response.status(400).json({ code: 'VOICE_METRIC_INVALID', message: 'مسیر تشخیص صدا معتبر نیست.' });
    recordVoiceMetric({
      provider,
      model: provider === 'openai-realtime' ? (process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL || 'gpt-live-transcribe') : 'web-speech-fa-IR',
      durationMs: Math.min(60_000, Math.max(0, Number(request.body?.durationMs) || 0)),
      firstTranscriptMs: Math.min(60_000, Math.max(0, Number(request.body?.firstTranscriptMs) || 0)),
      latencyMs: Math.min(60_000, Math.max(0, Number(request.body?.latencyMs) || 0)),
      transactionCount: Math.min(20, Math.max(0, Number(request.body?.transactionCount) || 0)),
      needsReview: Boolean(request.body?.needsReview),
    });
    if (provider === 'openai-realtime') recordRealtimeProviderDuration(Math.min(60_000, Math.max(0, Number(request.body?.durationMs) || 0)));
    return response.status(204).end();
  });
  app.get('/api/voice/status', (_request, response) => response.json(voiceProviderStatus()));
  app.get('/api/voice/stats', (_request, response) => response.json(voiceStats()));
}
