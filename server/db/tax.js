import { askTaxAssistant as askTaxAssistantCore, listTaxAssistantQuestions as listTaxAssistantQuestionsCore, listTaxKnowledgeSources as listTaxKnowledgeSourcesCore, resolveTaxAssistantQuestion as resolveTaxAssistantQuestionCore, saveTaxKnowledgeSource as saveTaxKnowledgeSourceCore } from '../taxAssistant.js';
import { audit, currentWorkspace, db } from './core.js';
import { citableVersionsAt, getTaxDocument as getTaxDocumentCore, getTaxDocumentVersion as getTaxDocumentVersionCore, listTaxDocuments as listTaxDocumentsCore, listTaxReviewQueue as listTaxReviewQueueCore, publishTaxDocumentVersion as publishTaxDocumentVersionCore, rejectTaxDocumentVersion as rejectTaxDocumentVersionCore, saveTaxDocumentDraft as saveTaxDocumentDraftCore, saveTaxDocumentRelation as saveTaxDocumentRelationCore } from '../taxKnowledge.js';
import { listTaxRates as listTaxRatesCore, saveTaxRate as saveTaxRateCore, taxReport as taxReportCore } from '../tax.js';

export function listTaxRates() {
  return listTaxRatesCore(db);
}

export function saveTaxRate(values = {}) {
  const item = saveTaxRateCore(db, values);
  audit(values.id ? 'update' : 'create', 'tax_rate', item.id, { name: item.name, rate: item.rate, treatment: item.treatment, active: item.active });
  return item;
}

export function taxReport(filters = {}) {
  return taxReportCore(db, filters);
}

export function listTaxKnowledgeSources(filters = {}) {
  return listTaxKnowledgeSourcesCore(db, filters);
}

export function saveTaxKnowledgeSource(values = {}) {
  const item = saveTaxKnowledgeSourceCore(db, values, currentWorkspace());
  audit(values.id ? 'update-source' : 'create-source', 'tax_knowledge_source', item.id, {
    title: item.title, issuer: item.issuer, versionLabel: item.versionLabel, status: item.status,
  });
  return item;
}

// --- هستهٔ منابع نسخه‌دار (فاز ۰) ---
// این توابع فقط می‌خوانند. مسیر پاسخ دستیار هنوز از `tax_knowledge_sources`
// می‌آید و در فاز ۲ و ۳ جابه‌جا می‌شود، پس امروز هیچ رفتاری عوض نمی‌شود.

export function listTaxDocuments(filters = {}) {
  return listTaxDocumentsCore(db, filters);
}

export function getTaxDocument(id) {
  return getTaxDocumentCore(db, id);
}

export function citableTaxVersions(filters = {}) {
  return citableVersionsAt(db, filters);
}

export function saveTaxDocumentRelation(values = {}) {
  const item = saveTaxDocumentRelationCore(db, values);
  audit('create-relation', 'tax_document_relation', item.id, {
    relation: item.relation, effectFrom: item.effect_from,
  });
  return item;
}

export function saveTaxDocumentDraft(values = {}) {
  const item = saveTaxDocumentDraftCore(db, values, currentWorkspace());
  audit('create-draft', 'tax_document_version', item.id, {
    documentId: item.documentId, versionLabel: item.versionLabel, provisions: item.provisions.length,
  });
  return item;
}

export function getTaxDocumentVersion(id) {
  return getTaxDocumentVersionCore(db, id);
}

export function listTaxReviewQueue() {
  return listTaxReviewQueueCore(db);
}

export function publishTaxDocumentVersion(id) {
  const item = publishTaxDocumentVersionCore(db, id, currentWorkspace());
  if (item) audit('publish', 'tax_document_version', item.id, { versionLabel: item.versionLabel, verifiedBy: item.verifiedBy });
  return item;
}

export function rejectTaxDocumentVersion(id, reason = '') {
  const item = rejectTaxDocumentVersionCore(db, id, reason, currentWorkspace());
  if (item) audit('reject', 'tax_document_version', item.id, { reason: String(reason).slice(0, 200) });
  return item;
}

export function askTaxAssistant(values = {}) {
  const item = askTaxAssistantCore(db, values, currentWorkspace());
  audit(item.status === 'answered' ? 'answer-from-source' : 'refer-to-expert', 'tax_assistant_question', item.id, {
    riskLevel: item.riskLevel, sourceCount: item.sources.length,
  });
  return item;
}

export function listTaxAssistantQuestions(filters = {}) {
  return listTaxAssistantQuestionsCore(db, filters);
}

export function resolveTaxAssistantQuestion(id, values = {}) {
  const item = resolveTaxAssistantQuestionCore(db, id, values, currentWorkspace());
  if (item) audit('expert-answer', 'tax_assistant_question', item.id, { sourceCount: item.sources.length });
  return item;
}
