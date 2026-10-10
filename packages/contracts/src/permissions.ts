/**
 * Коды прав — единственный источник (ADR-007). Список наполняется на этапах 4–5 вместе с
 * маршрутами; роль без прав пуста по умолчанию.
 */
export const PERMISSIONS = [] as const satisfies readonly string[];

export type PermissionCode = (typeof PERMISSIONS)[number];
