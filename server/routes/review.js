// صف حسابدار، رویدادهای مالی، تأییدها، قانون‌ها و یادگیری.
//
// از server/index.js جدا شد؛ بدنهٔ مسیرها دست نخورده و ترتیب ثبتشان همان ترتیب قبلی است.
// احراز هویت، CSRF و مرز نقش و تجربه پیش از این‌ها در index.js اعمال می‌شود.

import { resolveUnquantifiedReview } from '../db/reviewIntakes.js';
import {
  deleteAutomationRule, deleteLearning, getLearnings, listAutomationRules, reviewQueue, reviewAssistantHistory, analyzeReviewEvent, recordReviewPriorBasis, reviewAiFeedback, recordReviewedComposite, approveEvent, reverseEvent, rejectEvent, eventAudit, answerEvent, eventDecision, runRecognition, blockedRecognition, catchUpRecognition, unscheduledBalances, scheduleBalance, releaseHeldItem, pendingConfirmations, confirmPending, handOverPending, answerPending, automationPolicy, saveAutomationPolicy, setUnderstandingForAll, listUnidentifiedReceipts, resolveUnidentifiedReceipt, reverseUnidentifiedReceiptResolution, saveLearning, saveAutomationRule, updateLearning,
} from '../db.js';
import { DEFAULT_AUTOMATION_POLICY } from '../../shared/automationPolicy.js';
import { setEventTopicLabel } from '../topicPromotion.js';
import { aiLessonThreshold, decideAiLesson, exportAiLessons, listAiLessons, saveAiLessonThreshold } from '../db/aiLessons.js';

export function registerReviewRoutes(app) {
  app.post('/api/financial-events/intakes/:id/resolve', (request, response, next) => {
    try { return response.json({ item: resolveUnquantifiedReview(request.params.id, request.body || {}) }); }
    catch (error) { return next(error); }
  });
  // پرسش‌های صاحب کسب‌وکار.
  //
  // عمداً بیرون از `/financial-events` است: آن بخش ابزار حسابدار است و در تجربهٔ
  // ساده بسته می‌ماند. این مسیر همان دادهٔ زیرین را می‌خواند ولی فقط مواردی که
  // کاربر می‌تواند جوابشان را بدهد و بدون هیچ عدد و اصطلاح حسابداری.
  app.get('/api/confirmations', (request, response, next) => {
    try { return response.json(pendingConfirmations(Number(request.query.limit) || 5)); } catch (error) { return next(error); }
  });
  app.post('/api/confirmations/:id/confirm', (request, response, next) => {
    try { return response.json({ item: confirmPending(request.params.id) }); } catch (error) { return next(error); }
  });
  app.post('/api/confirmations/:id/handover', (request, response, next) => {
    try { return response.json({ item: handOverPending(request.params.id) }); } catch (error) { return next(error); }
  });
  // جواب به سؤال موتور (دورهٔ پوشش، قابل استرداد، بابت پول) از همان کارت امروز.
  app.post('/api/confirmations/:id/answer', (request, response, next) => {
    try { return response.json({ item: answerPending(request.params.id, { fact: request.body?.fact, value: request.body?.value, freeText: request.body?.freeText }) }); } catch (error) { return next(error); }
  });
  app.get('/api/automation-policy', (_request, response, next) => {
    try { return response.json({ policy: automationPolicy(), defaults: DEFAULT_AUTOMATION_POLICY }); } catch (error) { return next(error); }
  });
  app.put('/api/automation-policy/understanding', (request, response, next) => {
    try { return response.json({ policy: setUnderstandingForAll(request.body?.all === true) }); } catch (error) { return next(error); }
  });
  app.put('/api/automation-policy', (request, response, next) => {
    try { return response.json({ policy: saveAutomationPolicy(request.body || {}) }); } catch (error) { return next(error); }
  });
  // وجوه ناشناس: فهرست، تعیین تکلیف و برگشت آن.
  app.get('/api/financial-events/unidentified', (request, response, next) => {
    try { return response.json(listUnidentifiedReceipts({ includeClosed: request.query.closed === '1' })); } catch (error) { return next(error); }
  });
  app.post('/api/financial-events/unidentified/:lineId/resolve', (request, response, next) => {
    try { return response.status(201).json({ item: resolveUnidentifiedReceipt(request.params.lineId, request.body || {}) }); } catch (error) { return next(error); }
  });
  app.post('/api/financial-events/unidentified/resolutions/:id/reverse', (request, response, next) => {
    try { return response.json({ item: reverseUnidentifiedReceiptResolution(request.params.id) }); } catch (error) { return next(error); }
  });
  app.get('/api/financial-events/review-queue', (request, response, next) => {
    try { return response.json(reviewQueue({ limit: Number(request.query.limit) || 50 })); } catch (error) { return next(error); }
  });
  app.get('/api/financial-events/:id/ai-conversation', (request,response,next) => {
    try { return response.json(reviewAssistantHistory(request.params.id)); } catch(error) {return next(error);}
  });
  app.post('/api/financial-events/:id/ai-proposal', async (request, response, next) => {
    try { return response.json(await analyzeReviewEvent(request.params.id,{message:request.body?.message,facts:request.body?.facts || {}})); } catch (error) { return next(error); }
  });
  app.post('/api/financial-events/:id/ai-feedback', (request, response, next) => {
    try { return response.json(reviewAiFeedback(request.params.id, String(request.body?.proposalId || ''), { accepted: request.body?.accepted === true, reason: String(request.body?.reason || '').slice(0, 1000) })); } catch (error) { return next(error); }
  });
  app.post('/api/financial-events/:id/prior-basis', (request,response,next)=>{
    try {return response.status(201).json(recordReviewPriorBasis(request.params.id,request.body || {}));} catch(error) {return next(error);}
  });
  app.post('/api/financial-events/:id/reviewed-journal', (request, response, next) => {
    try { return response.status(201).json(recordReviewedComposite(request.params.id, request.body || {})); }
    catch (error) { return next(error); }
  });
  app.get('/api/financial-events/:id/audit', (request, response, next) => {
    try { return response.json(eventAudit(request.params.id)); } catch (error) { return next(error); }
  });
  app.post('/api/financial-events/run-recognition', (_request, response, next) => {
    try { return response.json(runRecognition()); } catch (error) { return next(error); }
  });
  app.get('/api/financial-events/blocked-recognition', (_request, response, next) => {
    try { return response.json(blockedRecognition()); } catch (error) { return next(error); }
  });
  app.post('/api/financial-events/recognition-items/:key/catch-up', (request, response, next) => {
    try { return response.status(201).json(catchUpRecognition(request.params.key, String(request.body?.reason || '').slice(0, 500))); } catch (error) { return next(error); }
  });
  // قلمی که تور ایمنیِ مانده نگه داشته، با دلیل حسابدار کنار می‌رود.
  app.post('/api/financial-events/recognition-items/:key/release', (request, response, next) => {
    try { return response.json(releaseHeldItem(request.params.key, String(request.body?.reason || '').slice(0, 500))); } catch (error) { return next(error); }
  });
  // ماندهٔ پیش‌پرداخت و درآمد انتقالیِ بی‌برنامه، و جواب حسابدار به سؤال دوره‌اش.
  app.get('/api/financial-events/unscheduled-balances', (_request, response, next) => {
    try { return response.json(unscheduledBalances()); } catch (error) { return next(error); }
  });
  app.post('/api/financial-events/unscheduled-balances/:accountId/schedule', (request, response, next) => {
    try { return response.status(201).json(scheduleBalance(request.params.accountId, request.body || {})); } catch (error) { return next(error); }
  });
  app.get('/api/financial-events/:id/decision', (request, response, next) => {
    try { return response.json(eventDecision(request.params.id)); } catch (error) { return next(error); }
  });
  app.post('/api/financial-events/:id/answer', (request, response, next) => {
    try { return response.json({ item: answerEvent(request.params.id, request.body || {}) }); } catch (error) { return next(error); }
  });
  app.post('/api/financial-events/:id/approve', (request, response, next) => {
    try { return response.json({ item: approveEvent(request.params.id, { reason: String(request.body?.reason || '').slice(0, 500) }) }); } catch (error) { return next(error); }
  });
  app.post('/api/financial-events/:id/reverse', (request, response, next) => {
    try { return response.json({ item: reverseEvent(request.params.id, String(request.body?.reason || '')) }); } catch (error) { return next(error); }
  });
  app.post('/api/financial-events/:id/reject', (request, response, next) => {
    try { return response.json({ item: rejectEvent(request.params.id, String(request.body?.reason || '')) }); } catch (error) { return next(error); }
  });
  app.post('/api/financial-events/:id/topic-label', (request, response, next) => {
    try { return response.json({ item: setEventTopicLabel(request.params.id, request.body?.label || '') }); } catch (error) { return next(error); }
  });
  app.get('/api/automation-rules', (request, response) => response.json({ items: listAutomationRules(request.query.source) }));
  app.post('/api/automation-rules', (request, response, next) => { try { return response.status(201).json({ item: saveAutomationRule(request.body || {}) }); } catch (error) { return next(error); } });
  app.delete('/api/automation-rules/:id', (request, response) => response.status(deleteAutomationRule(request.params.id) ? 204 : 404).end());
  app.get('/api/learnings', (_request, response) => response.json({ items: getLearnings() }));
  app.post('/api/learnings', (request, response, next) => { try { response.status(201).json({ item: saveLearning(request.body || {}) }); } catch (error) { next(error); } });
  app.put('/api/learnings/:id', (request, response, next) => { try { const item = updateLearning(request.params.id, request.body || {}); if (!item) return response.status(404).json({ message: 'یادگیری پیدا نشد.' }); return response.json({ item }); } catch (error) { return next(error); } });
  app.delete('/api/learnings/:id', (request, response) => response.status(deleteLearning(request.params.id) ? 204 : 404).end());
  // درس‌های پارسر از ثبت‌های تأییدشدهٔ AI (server/db/aiLessons.js): دیدن برای همه، تصمیم
  // با حسابدار، تعداد تأییدِ لازم برای یادگیریِ خودکار با مدیر دفتر.
  app.get('/api/ai-lessons', (_request, response, next) => { try { return response.json(listAiLessons()); } catch (error) { return next(error); } });
  app.get('/api/ai-lessons/threshold', (_request, response) => response.json({ threshold: aiLessonThreshold() }));
  app.get('/api/ai-lessons/export', (_request, response, next) => {
    try {
      response.setHeader('Content-Disposition', `attachment; filename="hesab-yar-ai-lessons-${new Date().toISOString().slice(0, 10)}.json"`);
      return response.json(exportAiLessons());
    } catch (error) { return next(error); }
  });
  app.post('/api/ai-lessons/threshold', (request, response, next) => { try { return response.json({ threshold: saveAiLessonThreshold(request.body?.threshold) }); } catch (error) { return next(error); } });
  app.post('/api/ai-lessons/:id/decide', (request, response, next) => { try { return response.json({ item: decideAiLesson(request.params.id, request.body || {}) }); } catch (error) { return next(error); } });
}
