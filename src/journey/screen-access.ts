// Screens follow the access matrix of the ТЗ (builder-docs PRODUCT_LIFECYCLE.md §4.5, «Кто что может»). Each screen is
// for one role and shows the data of its features; what that role may do with that data decides what the screen may
// offer: a form only where the role may create or change, a list only where it may look. Nothing here is guessed: an
// older ТЗ without a matrix has no such checks.
import { tr } from '../i18n/i18n.js';
import type { AccessAction } from './spec-extras.js';
import type { BusinessProcess } from './process.js';
import type { AppFeatures, AppScreen, AppScreens, BlockKind } from './webapp.js';

/** Features every role has on its start screen; their data (the account) is not «data shown on the screen». */
const SERVICE_FEATURES = new Set(['signin', 'privacy']);
const VIEW_BLOCKS: BlockKind[] = ['list', 'table', 'details', 'search', 'stats'];

/** Names of the records: the account and the process's data. */
export function dataNames(process: BusinessProcess | null): Record<string, string> {
  return { user: tr('Пользователь'), ...Object.fromEntries((process?.data ?? []).filter((entity) => entity.key !== 'user').map((entity) => [entity.key, entity.name])) };
}

export interface ScreenData { entity: string; name: string; actions: AccessAction[]; scope: 'own' | 'all' | null }

/** The data a screen works with: the records of its features, in the order they first appear. */
export function screenEntities(screen: AppScreen, features: AppFeatures): string[] {
  const keys = screen.features.filter((key) => !SERVICE_FEATURES.has(key));
  return [...new Set(features.features.filter((feature) => keys.includes(feature.key)).flatMap((feature) => feature.data ?? []))];
}

/** What the screen's role may do with each record of the screen, by the matrix. */
export function screenData(screen: AppScreen, features: AppFeatures, names: Record<string, string>): ScreenData[] {
  return screenEntities(screen, features).map((entity) => {
    const row = (features.access ?? []).find((item) => item.role === screen.role && item.data === entity);
    return { entity, name: names[entity] ?? entity, actions: row?.actions ?? [], scope: row?.scope ?? null };
  });
}

export interface ScreenAccessFinding { code: string; severity: 'important' | 'minor'; category: 'security' | 'logic'; target: string; screen: string | null; message: string; fix: string }

/** Where the screens and the matrix disagree. Empty when the ТЗ has no matrix yet. */
export function screenAccessIssues(value: AppScreens, features: AppFeatures | null, names: Record<string, string>): ScreenAccessFinding[] {
  if (!features || !(features.access ?? []).length) return [];
  const out: ScreenAccessFinding[] = [];
  const roleName = (key: string) => features.roles.find((role) => role.key === key)?.name ?? key;
  for (const screen of value.screens) {
    // A feature the ТЗ gives to other roles: its data and actions should not be on this role's screen.
    for (const key of screen.features) {
      const feature = features.features.find((item) => item.key === key);
      if (feature && !SERVICE_FEATURES.has(key) && feature.roles.length && !feature.roles.includes(screen.role)) out.push({
        code: 'SCREENS_FEATURE_NOT_FOR_ROLE', severity: 'important', category: 'security', target: screen.key, screen: screen.title,
        message: tr('На экране роли «{0}» есть функция «{1}», а в ТЗ она для других ролей.', [roleName(screen.role), feature.title]),
        fix: tr('Уберите функцию с экрана или добавьте роль к функции в ТЗ.'),
      });
    }
    const data = screenData(screen, features, names);
    const blind = data.filter((item) => !item.actions.length);
    if (blind.length) out.push({
      code: 'SCREENS_DATA_NOT_ALLOWED', severity: 'important', category: 'security', target: screen.key, screen: screen.title,
      message: tr('Экран роли «{0}» работает с данными {1}, а в ТЗ этой роли с ними ничего делать нельзя.', [roleName(screen.role), blind.map((item) => `«${item.name}»`).join(', ')]),
      fix: tr('Уберите эти данные с экрана или разрешите роли нужное на вкладке ТЗ «Кто что может».'),
    });
    const visible = data.filter((item) => item.actions.length);
    const showsData = screen.blocks.some((block) => VIEW_BLOCKS.includes(block.kind));
    const hasForm = screen.blocks.some((block) => block.kind === 'form');
    if (visible.length && showsData && !visible.some((item) => item.actions.includes('view'))) out.push({
      code: 'SCREENS_VIEW_NOT_ALLOWED', severity: 'important', category: 'security', target: screen.key, screen: screen.title,
      message: tr('Экран показывает записи {0}, а роли «{1}» по ТЗ их смотреть нельзя — только {2}.', [visible.map((item) => `«${item.name}»`).join(', '), roleName(screen.role), [...new Set(visible.flatMap((item) => item.actions))].map(actionWord).join(', ')]),
      fix: tr('Оставьте на экране только форму или разрешите роли смотреть эти данные в ТЗ.'),
    });
    if (visible.length && hasForm && !visible.some((item) => item.actions.includes('create') || item.actions.includes('edit'))) out.push({
      code: 'SCREENS_FORM_NOT_ALLOWED', severity: 'important', category: 'security', target: screen.key, screen: screen.title,
      message: tr('На экране есть форма, а роли «{0}» по ТЗ нельзя ни создавать, ни менять {1}.', [roleName(screen.role), visible.map((item) => `«${item.name}»`).join(', ')]),
      fix: tr('Уберите форму или разрешите роли создавать или менять эти данные в ТЗ.'),
    });
  }
  // The other way: what a role may create by the ТЗ, with a feature for it, but no screen of the role lets it.
  for (const row of features.access ?? []) {
    if (!row.actions.includes('create')) continue;
    const used = features.features.some((feature) => feature.roles.includes(row.role) && (feature.data ?? []).includes(row.data) && !SERVICE_FEATURES.has(feature.key));
    const own = value.screens.filter((screen) => screen.role === row.role);
    if (!used || !own.length) continue;
    if (!own.some((screen) => screen.blocks.some((block) => block.kind === 'form') && screenEntities(screen, features).includes(row.data))) out.push({
      code: 'SCREENS_CREATE_MISSING', severity: 'minor', category: 'logic', target: row.role, screen: null,
      message: tr('Роли «{0}» по ТЗ можно создавать «{1}», но ни на одном её экране нет для этого формы.', [roleName(row.role), names[row.data] ?? row.data]),
      fix: tr('Добавьте форму на экран с этой функцией или уберите право в ТЗ.'),
    });
  }
  return out;
}

function actionWord(action: AccessAction): string {
  return { view: tr('смотреть'), create: tr('создавать'), edit: tr('менять'), delete: tr('удалять') }[action];
}
