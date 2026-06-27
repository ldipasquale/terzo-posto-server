export const PERMISSIONS = {
  COMANDAS: 'comandas',
  BUFFET_GESTION: 'buffet_gestion',
  AGENDA: 'agenda',
  FINANZAS: 'finanzas',
};

export const ALL_PERMISSIONS = Object.values(PERMISSIONS);

export function parsePermissionsJson(value) {
  if (Array.isArray(value)) {
    return value.filter((p) => ALL_PERMISSIONS.includes(p));
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((p) => ALL_PERMISSIONS.includes(p))
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function getUserAccess(user) {
  return {
    isAdmin: Boolean(user?.isAdmin),
    permissions: parsePermissionsJson(user?.permissions),
  };
}

export function hasPermission(user, permission) {
  const access = getUserAccess(user);
  if (access.isAdmin) return true;
  return access.permissions.includes(permission);
}

export function hasAnyPermission(user, permissions) {
  const access = getUserAccess(user);
  if (access.isAdmin) return true;
  return permissions.some((p) => access.permissions.includes(p));
}

export function requireAdmin(user) {
  return Boolean(user?.isAdmin);
}
