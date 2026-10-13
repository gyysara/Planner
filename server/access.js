// Все правила доступа в одном месте.
// Команда = аккаунт-менеджер (team_id = его id) + привязанные к нему гейм-менеджеры.

const TASK_SELECT = `
SELECT t.*, p.name AS project_name, p.color AS project_color,
       a.name AS assignee_name, a.avatar AS assignee_avatar, a.role AS assignee_role,
       au.name AS author_name
FROM tasks t
JOIN projects p ON p.id = t.project_id
JOIN users a ON a.id = t.assignee_id
JOIN users au ON au.id = t.author_id`;

// Условие видимости задач для пользователя: [sql, params]
function visibilityWhere(user) {
  if (user.role === 'am') return ['t.team_id = ?', [user.id]];
  if (!user.team_id) return ['0', []];
  // Гейм-менеджер видит задачи команды, где исполнитель — гейм-менеджер (он сам или коллеги)
  return [`t.team_id = ? AND a.role = 'gm' AND a.team_id = t.team_id`, [user.team_id]];
}

function getVisibleTask(db, user, taskId) {
  const [where, params] = visibilityWhere(user);
  return db.prepare(`${TASK_SELECT} WHERE t.id = ? AND ${where}`).get(taskId, ...params) || null;
}

function listVisibleTasks(db, user, { from, to } = {}) {
  const [where, params] = visibilityWhere(user);
  let sql = `${TASK_SELECT} WHERE ${where}`;
  const args = [...params];
  if (from) { sql += ' AND t.deadline >= ?'; args.push(from); }
  if (to) { sql += ' AND t.deadline < ?'; args.push(to); }
  return db.prepare(sql + ' ORDER BY t.deadline').all(...args);
}

function teamMembers(db, user) {
  if (!user.team_id) return db.prepare('SELECT * FROM users WHERE id = ?').all(user.id);
  return db.prepare(`SELECT * FROM users WHERE team_id = ? ORDER BY role, name`).all(user.team_id);
}

// Кого можно назначить исполнителем
function allowedAssignees(db, user) {
  if (user.role === 'am') {
    return db.prepare(`SELECT * FROM users WHERE id = ? OR (role = 'gm' AND team_id = ?) ORDER BY role, name`)
      .all(user.id, user.id);
  }
  return user.team_id ? [user] : [];
}

// В какие проекты можно ставить задачи
function allowedProjects(db, user) {
  if (user.role === 'am') return db.prepare('SELECT * FROM projects WHERE team_id = ? ORDER BY name').all(user.id);
  if (!user.team_id) return [];
  return db.prepare(`SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id
    WHERE m.user_id = ? AND p.team_id = ? ORDER BY p.name`).all(user.id, user.team_id);
}

function canEditTask(user, task) {
  return task.author_id === user.id;
}

function canChangeStatus(user, task) {
  return task.assignee_id === user.id || task.author_id === user.id;
}

module.exports = {
  TASK_SELECT, visibilityWhere, getVisibleTask, listVisibleTasks, teamMembers,
  allowedAssignees, allowedProjects, canEditTask, canChangeStatus,
};
