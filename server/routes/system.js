// پشتیبان دفتر.
//
// از server/index.js جدا شد؛ بدنهٔ مسیرها دست نخورده و ترتیب ثبتشان همان ترتیب قبلی است.
// احراز هویت، CSRF و مرز نقش و تجربه پیش از این‌ها در index.js اعمال می‌شود.

import { revokeWorkspaceSessions } from '../db.js';
import {
  automaticBackupConfigured, automaticBackupStatus, backupSummary, createPortableBackup, openEncryptedBackup, restorePortableBackup, writeServerBackup,
} from '../backup.js';
import { backupUpload } from './http.js';

export function registerSystemRoutes(app) {
  app.get('/api/backups/status', async (request, response, next) => {
    try { return response.json(await automaticBackupStatus(request.workspace.id)); }
    catch (error) { return next(error); }
  });
  app.post('/api/backups/export', (request, response, next) => {
    try {
      const encrypted = createPortableBackup(request.workspace, request.body?.passphrase);
      response.setHeader('Content-Disposition', `attachment; filename="hesab-yar-${request.workspace.id}-${new Date().toISOString().slice(0, 10)}.hybackup"`);
      response.setHeader('Content-Type', 'application/octet-stream');
      return response.send(encrypted);
    } catch (error) { return next(error); }
  });
  app.post('/api/backups/preview', backupUpload.single('backup'), (request, response, next) => {
    try {
      if (!request.file) return response.status(400).json({ code: 'BACKUP_MISSING', message: 'فایل پشتیبان را انتخاب کن.' });
      return response.json({ summary: backupSummary(openEncryptedBackup(request.file.buffer, request.body?.passphrase)) });
    } catch (error) { return next(error); }
  });
  app.post('/api/backups/restore', backupUpload.single('backup'), async (request, response, next) => {
    try {
      if (!request.file) return response.status(400).json({ code: 'BACKUP_MISSING', message: 'فایل پشتیبان را انتخاب کن.' });
      if (String(request.body?.confirmation || '').trim() !== 'بازیابی دفتر') return response.status(400).json({ code: 'RESTORE_CONFIRMATION_REQUIRED', message: 'برای تأیید، عبارت «بازیابی دفتر» را دقیق بنویس.' });
      const result = await restorePortableBackup(request.file.buffer, request.body?.passphrase, request.workspace);
      revokeWorkspaceSessions(request.workspace.id, request.user.id);
      return response.json(result);
    } catch (error) { return next(error); }
  });
  app.post('/api/backups/snapshot', async (request, response, next) => {
    try {
      if (!automaticBackupConfigured()) return response.status(503).json({ code: 'BACKUP_NOT_CONFIGURED', message: 'ابتدا BACKUP_ENCRYPTION_KEY را روی سرور تنظیم کن.' });
      return response.status(201).json({ backup: await writeServerBackup(request.workspace, { reason: 'manual' }) });
    } catch (error) { return next(error); }
  });
}
