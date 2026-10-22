// فهم رویداد با AI — پرونده، پاسخ، ثبت (docs/ai-event-understanding.md).
//
// از server/index.js جدا شد؛ بدنهٔ مسیرها دست نخورده و ترتیب ثبتشان همان ترتیب قبلی است.
// احراز هویت، CSRF و مرز نقش و تجربه پیش از این‌ها در index.js اعمال می‌شود.

import {
  getToday, answerUnderstandingCase, commitUnderstandingCase, createUnderstandingCase, dismissUnderstandingCase, getUnderstandingCase, listUnderstandingCases, retryUnderstandingCase, sendUnderstandingToAccountant, understandingReport,
} from '../db.js';

export function registerUnderstandingRoutes(app) {
  // فهم رویداد با AI — پرونده، پاسخ، ثبت. docs/ai-event-understanding.md
  app.get('/api/understanding/cases', (request, response) => response.json({ items: listUnderstandingCases(request.query || {}) }));
  app.get('/api/understanding/report', (_request, response) => response.json(understandingReport()));
  app.get('/api/understanding/cases/:id', (request, response, next) => {
    try { return response.json({ item: getUnderstandingCase(request.params.id) }); } catch (error) { return next(error); }
  });
  app.post('/api/understanding/cases', async (request, response, next) => {
    try { return response.status(201).json({ item: await createUnderstandingCase(request.body || {}) }); } catch (error) { return next(error); }
  });
  app.post('/api/understanding/cases/:id/answers', async (request, response, next) => {
    try { return response.json({ item: await answerUnderstandingCase(request.params.id, request.body?.answers || {}) }); } catch (error) { return next(error); }
  });
  app.post('/api/understanding/cases/:id/retry', async (request, response, next) => {
    try { return response.json({ item: await retryUnderstandingCase(request.params.id) }); } catch (error) { return next(error); }
  });
  app.post('/api/understanding/cases/:id/commit', (request, response, next) => {
    try { return response.json({ item: commitUnderstandingCase(request.params.id), ...getToday() }); } catch (error) { return next(error); }
  });
  app.post('/api/understanding/cases/:id/send-to-accountant', (request, response, next) => {
    try { return response.json({ item: sendUnderstandingToAccountant(request.params.id) }); } catch (error) { return next(error); }
  });
  app.post('/api/understanding/cases/:id/dismiss', (request, response, next) => {
    try { return response.json({ item: dismissUnderstandingCase(request.params.id) }); } catch (error) { return next(error); }
  });
}
