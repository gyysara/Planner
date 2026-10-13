class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    login: u.login,
    role: u.role,
    teamId: u.team_id,
    avatar: u.avatar ? `/files/${u.avatar}` : '/assets/img/avatar-default.svg',
  };
}

function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = { HttpError, publicUser, toId };
