import { randomBytes, randomUUID } from 'node:crypto';
import { audit, controlDb, invalidInput, workspaceDatabase } from './core.js';
import { hashPassword } from './auth.js';
import { normalizePlanId, quotaError, usageQuotaSnapshot } from '../collaboration.js';
import { passwordPolicy } from '../security.js';
import { workspacePlanRecord } from './commercial.js';

export function listUserWorkspaces(userId) {
  return controlDb.prepare(`SELECT workspaces.id,workspaces.name,workspaces.profile_type AS profileType,
    workspace_members.role,workspace_members.experience AS experiencePreference,workspaces.created_at AS createdAt
    FROM workspace_members JOIN workspaces ON workspaces.id=workspace_members.workspace_id
    WHERE workspace_members.user_id=? ORDER BY CASE workspace_members.role WHEN 'owner' THEN 0 ELSE 1 END,workspaces.created_at`).all(userId);
}

export function workspaceForUser(userId, requestedId = '') {
  const requested = String(requestedId || '').trim();
  const row = requested
    ? controlDb.prepare(`SELECT workspaces.id,workspaces.name,workspaces.profile_type AS profileType,workspace_members.role,
        workspace_members.experience AS experiencePreference
        FROM workspace_members JOIN workspaces ON workspaces.id=workspace_members.workspace_id
        WHERE workspace_members.user_id=? AND workspaces.id=?`).get(userId, requested)
    : listUserWorkspaces(userId)[0];
  return row || null;
}

export function createWorkspace(userId, values = {}) {
  const name = String(values.name || '').trim().slice(0, 100);
  if (name.length < 2) throw invalidInput('نام دفتر باید حداقل دو نویسه باشد.');
  const profileType = values.profileType === 'personal' ? 'personal' : 'business';
  const id = randomUUID();
  controlDb.exec('BEGIN IMMEDIATE');
  try {
    controlDb.prepare('INSERT INTO workspaces (id,name,profile_type,created_by) VALUES (?,?,?,?)').run(id, name, profileType, userId);
    controlDb.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?, 'owner')").run(id, userId);
    controlDb.prepare('INSERT INTO workspace_plans (workspace_id,plan_id,updated_by) VALUES (?,?,?)')
      .run(id, normalizePlanId(process.env.DEFAULT_WORKSPACE_PLAN), userId);
    controlDb.exec('COMMIT');
  } catch (error) { controlDb.exec('ROLLBACK'); throw error; }
  const database = workspaceDatabase(id);
  database.prepare("UPDATE settings SET value=? WHERE key='businessName'").run(name);
  database.prepare("UPDATE settings SET value=? WHERE key='profileType'").run(profileType);
  return workspaceForUser(userId, id);
}

export function listWorkspaceMembers(workspaceId) {
  return controlDb.prepare(`SELECT users.id,users.username,users.display_name AS displayName,
    users.must_change_password AS mustChangePassword,workspace_members.role,workspace_members.created_at AS createdAt
    FROM workspace_members JOIN users ON users.id=workspace_members.user_id
    WHERE workspace_members.workspace_id=?
    ORDER BY CASE workspace_members.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'accountant' THEN 2 ELSE 3 END,users.username`).all(workspaceId);
}

function assertWorkspaceRole(role) {
  if (!['owner', 'manager', 'accountant', 'viewer'].includes(role)) throw invalidInput('نقش انتخاب‌شده معتبر نیست.');
  return role;
}

export function addWorkspaceMember(workspaceId, values = {}) {
  const username = String(values.username || '').trim().toLowerCase().slice(0, 80);
  const displayName = String(values.displayName || '').trim().slice(0, 100);
  const role = assertWorkspaceRole(values.role || 'viewer');
  if (!/^[a-z0-9._-]{3,80}$/i.test(username)) throw invalidInput('نام کاربری باید حداقل سه نویسه و فقط شامل حروف انگلیسی، عدد، نقطه، خط تیره یا زیرخط باشد.');
  let user = controlDb.prepare('SELECT id,username FROM users WHERE username=?').get(username);
  const existingMembership = user && controlDb.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspaceId, user.id);
  if (!existingMembership) {
    const plan = workspacePlanRecord(workspaceId);
    const memberCount = Number(controlDb.prepare('SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id=?').get(workspaceId).count || 0);
    const memberQuota = usageQuotaSnapshot(plan.planId, { members: memberCount }).find((item) => item.id === 'members');
    if (memberQuota.exhausted) throw quotaError(memberQuota);
  }
  controlDb.exec('BEGIN IMMEDIATE');
  try {
    if (!user) {
      const password = String(values.temporaryPassword || '');
      const policy = passwordPolicy(password, username);
      if (!policy.valid) throw invalidInput(policy.message);
      const salt = randomBytes(24).toString('hex');
      user = { id: randomUUID(), username };
      controlDb.prepare(`INSERT INTO users (id,username,password_hash,password_salt,display_name,must_change_password,role)
        VALUES (?,?,?,?,?,1,?)`).run(user.id, username, hashPassword(password, salt), salt, displayName, role);
    } else if (displayName) {
      controlDb.prepare('UPDATE users SET display_name=? WHERE id=?').run(displayName, user.id);
    }
    controlDb.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)
      ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,updated_at=CURRENT_TIMESTAMP`).run(workspaceId, user.id, role);
    controlDb.exec('COMMIT');
  } catch (error) { controlDb.exec('ROLLBACK'); throw error; }
  return listWorkspaceMembers(workspaceId).find((item) => item.id === user.id);
}

export function updateWorkspaceMember(workspaceId, userId, role) {
  const nextRole = assertWorkspaceRole(role);
  const current = controlDb.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspaceId, userId);
  if (!current) return null;
  const owners = controlDb.prepare("SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id=? AND role='owner'").get(workspaceId).count;
  if (current.role === 'owner' && nextRole !== 'owner' && owners <= 1) throw invalidInput('دفتر باید حداقل یک مالک داشته باشد.');
  controlDb.prepare('UPDATE workspace_members SET role=?,updated_at=CURRENT_TIMESTAMP WHERE workspace_id=? AND user_id=?').run(nextRole, workspaceId, userId);
  return listWorkspaceMembers(workspaceId).find((item) => item.id === userId);
}

export function removeWorkspaceMember(workspaceId, userId) {
  const current = controlDb.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspaceId, userId);
  if (!current) return false;
  const owners = controlDb.prepare("SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id=? AND role='owner'").get(workspaceId).count;
  if (current.role === 'owner' && owners <= 1) throw invalidInput('آخرین مالک دفتر قابل حذف نیست.');
  return controlDb.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?').run(workspaceId, userId).changes > 0;
}

export function allWorkspaces() {
  return controlDb.prepare('SELECT id,name,profile_type AS profileType,created_at AS createdAt FROM workspaces ORDER BY created_at').all();
}

export function revokeWorkspaceSessions(workspaceId, exceptUserId = '') {
  const members = controlDb.prepare('SELECT user_id AS userId FROM workspace_members WHERE workspace_id=?').all(workspaceId);
  const remove = controlDb.prepare('DELETE FROM sessions WHERE user_id=?');
  for (const member of members) if (member.userId !== exceptUserId) remove.run(member.userId);
}

/**
 * ترجیح تجربهٔ کاربر در یک پرونده.
 *
 * فقط مالک می‌تواند انتخاب کند؛ حسابدار و مدیر همیشه محیط حرفه‌ای می‌گیرند چون
 * ابزار کارشان آنجاست. تلاش برای پایین‌آوردنشان بی‌صدا رد می‌شود، نه اینکه خطا
 * بدهد — درخواستش بی‌اثر است، نه نامعتبر.
 */
export function setExperiencePreference(workspaceId, userId, preference) {
  const value = ['simple', 'professional'].includes(preference) ? preference : null;
  controlDb.prepare('UPDATE workspace_members SET experience=?,updated_at=CURRENT_TIMESTAMP WHERE workspace_id=? AND user_id=?')
    .run(value, String(workspaceId || ''), String(userId || ''));
  audit('update', 'workspace-member', `${workspaceId}:${userId}`, { experience: value });
  return workspaceForUser(userId, workspaceId);
}
