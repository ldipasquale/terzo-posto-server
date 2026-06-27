import {
  hasAnyPermission,
  hasPermission,
  requireAdmin,
} from '../lib/userPermissions.js';

export function requireAdminMiddleware(req, res, next) {
  if (!requireAdmin(req.user)) {
    return res.status(403).json({ error: 'Acceso restringido a administradores' });
  }
  next();
}

export function requireAnyPermission(...permissions) {
  return (req, res, next) => {
    if (!hasAnyPermission(req.user, permissions)) {
      return res.status(403).json({ error: 'No tenés permiso para esta acción' });
    }
    next();
  };
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.user, permission)) {
      return res.status(403).json({ error: 'No tenés permiso para esta acción' });
    }
    next();
  };
}
