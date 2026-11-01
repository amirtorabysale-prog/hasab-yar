import { randomUUID } from 'node:crypto';
import { audit, db, invalidInput } from './core.js';
import { contactIdForName } from './contacts.js';
import { personnelCompleteness, validatePersonnel } from '../../shared/personnel.js';

/**
 * پروندهٔ پرسنل — پایهٔ حقوق و دستمزد.
 *
 * هر نفر همان «شخص»ی است که در طلب و بدهی و کارت حساب هست (نقش «پرسنل»)؛ پس
 * مساعده، وام یا بدهی‌اش به شرکت روی همان کارت دیده می‌شود و یک نفر دو ردیف جدا
 * نمی‌شود. اگر همان شخص شریک است، نقش «شریک» حفظ می‌شود (مدیرعامل شریک).
 *
 * پایان همکاری پرونده را پاک نمی‌کند؛ تاریخ پایان می‌خورد و از فهرست فعال بیرون
 * می‌رود، چون لیست‌های حقوق گذشته و سنوات به آن تکیه دارند.
 */

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      nickname TEXT NOT NULL DEFAULT '',
      national_id TEXT NOT NULL DEFAULT '',
      start_date TEXT,
      end_date TEXT,
      job_title TEXT NOT NULL DEFAULT '',
      department TEXT NOT NULL DEFAULT '',
      employment_type TEXT NOT NULL DEFAULT '',
      base_wage INTEGER NOT NULL DEFAULT 0,
      marital TEXT NOT NULL DEFAULT '',
      children INTEGER,
      insurance_number TEXT NOT NULL DEFAULT '',
      mobile TEXT NOT NULL DEFAULT '',
      iban TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_national_id ON employees(national_id) WHERE national_id != '';
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(employees)').all().map((column) => column.name));
  if (!columns.has('nickname')) db.exec("ALTER TABLE employees ADD COLUMN nickname TEXT NOT NULL DEFAULT ''");
}

const COLUMNS = `id,contact_id AS contactId,name,nickname,national_id AS nationalId,start_date AS startDate,end_date AS endDate,
  job_title AS jobTitle,department,employment_type AS employmentType,base_wage AS baseWage,marital,children,
  insurance_number AS insuranceNumber,mobile,iban,note,created_at AS createdAt,updated_at AS updatedAt`;

const hydrate = (row) => (row ? { ...row, active: !row.endDate, completeness: personnelCompleteness(row) } : null);

export function listEmployees({ includeEnded = false } = {}) {
  ensureSchema();
  const rows = db.prepare(`SELECT ${COLUMNS} FROM employees ${includeEnded ? '' : 'WHERE end_date IS NULL'} ORDER BY end_date IS NOT NULL, name`).all();
  return rows.map(hydrate);
}

export function getEmployee(id) {
  ensureSchema();
  return hydrate(db.prepare(`SELECT ${COLUMNS} FROM employees WHERE id=?`).get(String(id || '')));
}

function validationError(errors) {
  return Object.assign(invalidInput(errors[0].message), { code: 'PERSONNEL_INVALID', details: { errors } });
}

/**
 * ذخیرهٔ پرونده (تازه یا ویرایش). نام مشابهِ شخص موجود همان پرسش «همان شخص یا
 * جدا؟» را می‌سازد که بقیهٔ برنامه می‌پرسد (`counterpartyResolution`).
 */
export function saveEmployee(values = {}) {
  ensureSchema();
  const { value, errors } = validatePersonnel(values);
  if (errors.length) throw validationError(errors);
  const existing = values.id ? getEmployee(values.id) : null;
  if (values.id && !existing) throw Object.assign(invalidInput('پرونده پیدا نشد.'), { status: 404, code: 'PERSONNEL_MISSING' });
  if (value.nationalId) {
    const duplicate = db.prepare('SELECT id,name FROM employees WHERE national_id=? AND id!=?').get(value.nationalId, existing?.id || '');
    if (duplicate) throw validationError([{ field: 'nationalId', message: `این کد ملی برای «${duplicate.name}» ثبت شده است.` }]);
  }
  const id = existing?.id || randomUUID();
  const sameName = existing && existing.name === value.name;
  const contactId = sameName && existing.contactId ? existing.contactId : contactIdForName(value.name, values.counterpartyResolution);
  // نقش «شریک» دست نمی‌خورد؛ شخصِ بی‌نقش «پرسنل» می‌شود.
  if (contactId) db.prepare("UPDATE contacts SET role='employee',kind='person',updated_at=CURRENT_TIMESTAMP WHERE id=? AND role=''").run(contactId);
  db.prepare(`INSERT INTO employees (id,contact_id,name,nickname,national_id,start_date,job_title,department,employment_type,base_wage,
      marital,children,insurance_number,mobile,iban,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET contact_id=excluded.contact_id,name=excluded.name,nickname=excluded.nickname,national_id=excluded.national_id,
      start_date=excluded.start_date,job_title=excluded.job_title,department=excluded.department,employment_type=excluded.employment_type,
      base_wage=excluded.base_wage,marital=excluded.marital,children=excluded.children,insurance_number=excluded.insurance_number,
      mobile=excluded.mobile,iban=excluded.iban,note=excluded.note,updated_at=CURRENT_TIMESTAMP`)
    .run(id, contactId, value.name, value.nickname, value.nationalId, value.startDate || null, value.jobTitle, value.department, value.employmentType,
      value.baseWage, value.marital, value.children, value.insuranceNumber, value.mobile, value.iban, value.note);
  audit(existing ? 'update' : 'create', 'employee', id, { name: value.name });
  return getEmployee(id);
}

/** پایان همکاری: تاریخ پایان، نه حذف. تاریخ پیش از شروع کار پذیرفته نمی‌شود. */
export function endEmployment(id, { endDate } = {}) {
  const employee = getEmployee(id);
  if (!employee) throw Object.assign(invalidInput('پرونده پیدا نشد.'), { status: 404, code: 'PERSONNEL_MISSING' });
  const date = new Date(endDate || Date.now());
  if (Number.isNaN(date.getTime())) throw invalidInput('تاریخ پایان همکاری معتبر نیست.');
  if (employee.startDate && date < new Date(employee.startDate)) throw invalidInput('پایان همکاری پیش از شروع کار است.');
  db.prepare('UPDATE employees SET end_date=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(date.toISOString(), employee.id);
  audit('end', 'employee', employee.id, { endDate: date.toISOString() });
  return getEmployee(employee.id);
}

export function resumeEmployment(id) {
  const employee = getEmployee(id);
  if (!employee) throw Object.assign(invalidInput('پرونده پیدا نشد.'), { status: 404, code: 'PERSONNEL_MISSING' });
  db.prepare('UPDATE employees SET end_date=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(employee.id);
  audit('resume', 'employee', employee.id);
  return getEmployee(employee.id);
}
