// Turns a stored analysis report (codes and evidence) into texts in the reader's language, and into Markdown.
import { tr } from '../i18n/i18n.js';
import type { AnalysisReport, Finding } from './code-analysis.js';

const findingTexts: Record<string, { title: string; explanation: string; remediation: string }> = {
  ENV_FILE_COMMITTED: {
    title: 'В архиве есть файл с настройками окружения',
    explanation: 'Файлы .env обычно хранят пароли и ключи. Если они попали в репозиторий или архив, их может прочитать любой, у кого есть копия.',
    remediation: 'Уберите файл из репозитория, добавьте его в .gitignore и замените ключи, которые в нём были. Для примера оставьте .env.example без настоящих значений.',
  },
  SECRET_IN_CODE: {
    title: 'В коде похоже на настоящий ключ или пароль ({kind})',
    explanation: 'Найдена строка, похожая на ключ доступа. Само значение в отчёт не копируется — только файл и строка.',
    remediation: 'Перенесите значение в переменные окружения и выпустите новый ключ у сервиса: старый нужно считать раскрытым.',
  },
  UNSAFE_ARCHIVE_PATHS: {
    title: 'В архиве есть небезопасные пути к файлам',
    explanation: 'Имена с «..», абсолютные пути или обратные косые черты при распаковке могут записать файл за пределы папки. BuildPath архив не распаковывал.',
    remediation: 'Пересоберите архив из папки проекта обычным способом.',
  },
  SYMLINKS_IN_ARCHIVE: {
    title: 'В архиве есть символические ссылки',
    explanation: 'Ссылки могут указывать на файлы вне проекта. Их содержимое не читалось.',
    remediation: 'Проверьте, нужны ли эти ссылки; лучше хранить в репозитории сами файлы.',
  },
  DEPENDENCIES_COMMITTED: {
    title: 'В архив попали сторонние библиотеки',
    explanation: 'Папки вроде node_modules или vendor — копии чужого кода. Они раздувают репозиторий и устаревают незаметно. Эти папки не разбирались.',
    remediation: 'Удалите папки из репозитория, добавьте их в .gitignore и ставьте зависимости по файлу блокировки версий.',
  },
  BUILD_OUTPUT_COMMITTED: {
    title: 'В архив попали результаты сборки',
    explanation: 'Папки dist, .next, out или coverage создаются при сборке и не нужны в исходниках.',
    remediation: 'Удалите их и добавьте в .gitignore.',
  },
  LARGE_FILES: {
    title: 'Большие файлы в проекте',
    explanation: 'Файлы больше 5 МБ замедляют загрузку и работу с репозиторием.',
    remediation: 'Сожмите изображения и видео или храните их отдельно (хранилище файлов, CDN).',
  },
  PACKAGE_JSON_INVALID: {
    title: 'package.json не читается',
    explanation: 'Файл с описанием зависимостей содержит ошибку, поэтому проект, скорее всего, не соберётся.',
    remediation: 'Исправьте синтаксис JSON.',
  },
  LOCKFILE_MISSING: {
    title: 'Нет файла блокировки версий',
    explanation: 'Без него при каждой установке могут приехать другие версии библиотек, и сборка будет вести себя по-разному.',
    remediation: 'Установите зависимости один раз и добавьте созданный файл (package-lock.json, yarn.lock, pnpm-lock.yaml или composer.lock) в репозиторий.',
  },
  NO_BUILD_SCRIPT: {
    title: 'Нет команды сборки',
    explanation: 'В package.json нет скрипта build, поэтому неясно, как собрать проект для публикации.',
    remediation: 'Добавьте скрипт build или опишите сборку в README.',
  },
  NO_TEST_SCRIPT: {
    title: 'Нет команды запуска тестов',
    explanation: 'В package.json нет рабочего скрипта test.',
    remediation: 'Добавьте тесты и скрипт test, чтобы проверка шла автоматически.',
  },
  UNPINNED_DEPENDENCIES: {
    title: 'Версии некоторых библиотек не указаны',
    explanation: 'Зависимости с версией «*» или «latest»: {names}. Любое обновление библиотеки может сломать проект.',
    remediation: 'Укажите конкретные версии или диапазоны.',
  },
  README_MISSING: {
    title: 'Нет README',
    explanation: 'Без описания новому разработчику трудно понять, как запустить и собрать проект.',
    remediation: 'Добавьте README: что это, как установить, запустить, собрать и где настройки.',
  },
  LICENSE_MISSING: {
    title: 'Не указана лицензия',
    explanation: 'Это важно, если код будут передавать или публиковать.',
    remediation: 'Добавьте файл LICENSE, если код открытый, или зафиксируйте права в договоре.',
  },
  NO_TESTS_FOUND: {
    title: 'Тесты не найдены',
    explanation: 'По именам файлов и папок тестов не видно. Возможно, они лежат в необычном месте.',
    remediation: 'Добавьте хотя бы проверки главных сценариев.',
  },
  DOC_NO_TEXT: {
    title: 'В PDF нет текста',
    explanation: 'Похоже, это скан или картинки: текст из документа не извлекается, поэтому проверить его нельзя.',
    remediation: 'Загрузите документ в Word или PDF с текстом (экспорт из редактора, а не скан).',
  },
  DOC_TOO_SHORT: {
    title: 'Документ очень короткий ({words} слов)',
    explanation: 'По такому описанию исполнитель будет додумывать почти всё сам.',
    remediation: 'Опишите хотя бы цель, для кого продукт, что он должен делать и как вы поймёте, что работа принята.',
  },
  DOC_NO_STRUCTURE: {
    title: 'В документе нет заголовков',
    explanation: 'Текст идёт сплошным потоком — на него трудно ссылаться и легко что-то пропустить.',
    remediation: 'Разбейте документ на разделы с заголовками: цель, аудитория, функции, страницы, сроки, приёмка.',
  },
  DOC_SECTION_MISSING: {
    title: 'Не найден раздел: {sectionLabel}',
    explanation: 'Ни в заголовках, ни в тексте не нашлось слов, которыми обычно описывают этот раздел. Возможно, он назван иначе.',
    remediation: 'Если раздела нет — добавьте его; если он есть под другим названием, назовите его привычнее.',
  },
  DOC_VAGUE_WORDING: {
    title: 'Размытые формулировки',
    explanation: 'Слова вроде «удобный», «современный», «быстро», «и т.д.» нельзя проверить при приёмке: каждый поймёт их по-своему.',
    remediation: 'Замените их измеримым: «страница открывается за 2 секунды на телефоне», «заявка — за 3 шага», перечислите всё вместо «и т.д.».',
  },
  DOC_OPEN_QUESTIONS: {
    title: 'Остались открытые вопросы',
    explanation: 'В документе есть пометки «уточнить», «обсудить», «TBD» или «???» — по этим местам решения ещё нет.',
    remediation: 'Решите вопросы до начала работ или отметьте, кто и когда их решит.',
  },
  DOC_PERSONAL_DATA: {
    title: 'В документе есть контакты или личные данные',
    explanation: 'Найдены адреса почты, телефоны или похожие на ИИН номера. Документ стоит передавать только тем, кому он нужен.',
    remediation: 'Проверьте, нужны ли эти данные исполнителю; лишнее уберите.',
  },
  GITIGNORE_MISSING: {
    title: 'Нет .gitignore',
    explanation: 'Без него в репозиторий легко попадают секреты, зависимости и результаты сборки.',
    remediation: 'Добавьте .gitignore для вашего стека.',
  },
};

const sectionLabels: Record<string, string> = {
  goal: 'Цель', audience: 'Для кого', features: 'Функции и требования', pages: 'Страницы и экраны', content: 'Тексты и материалы', design: 'Дизайн',
  integrations: 'Интеграции и оплата', deadline: 'Сроки', budget: 'Бюджет', acceptance: 'Критерии приёмки',
};
const severityLabels: Record<string, string> = { high: 'Важно', medium: 'Средне', low: 'Мелочь', info: 'К сведению' };
const categoryLabels: Record<string, string> = { security: 'Безопасность', structure: 'Структура', dependencies: 'Зависимости', docs: 'Документация', quality: 'Качество' };
const checkLabels: Record<string, string> = {
  inventory: 'Состав файлов и языки', stack: 'Технологии', secrets: 'Секреты и ключи в коде', structure: 'Структура репозитория',
  dependencies: 'Файлы зависимостей', docs: 'README и лицензия', vulnerabilities: 'Уязвимости библиотек', build_and_tests: 'Сборка и тесты',
  doc_text: 'Текст документа', doc_sections: 'Обычные разделы ТЗ', doc_wording: 'Размытые формулировки', doc_open_questions: 'Открытые вопросы', doc_meaning: 'Смысл и противоречия',
};
const checkStatusLabels: Record<string, string> = { run: 'Проверено', partial: 'Проверено частично', skipped: 'Не проверялось' };
const unverifiedLabels: Record<string, string> = {
  runtime: 'Как код работает: он не запускался, разбор шёл только по файлам.',
  build: 'Собирается ли проект: сборка не выполнялась.',
  tests: 'Проходят ли тесты: они не запускались.',
  vulnerabilities: 'Известные уязвимости библиотек: база уязвимостей не подключена.',
  site_quality: 'Скорость, доступность и SEO готового сайта: для этого нужна проверка опубликованного сайта.',
  encrypted: 'Зашифрованные файлы архива: их содержимое не читалось.',
  large_files: 'Большие текстовые файлы: прочитаны не все, чтобы не превысить лимит разбора.',
  long_lines: 'Очень длинные строки (сжатый код): в них не искались ключи и пароли.',
  doc_meaning: 'Смысл документа и противоречия: проверка идёт по словам и разделам, содержание не оценивалось.',
  doc_images: 'Рисунки, схемы и таблицы-картинки: из них текст не извлекается.',
  doc_scanned: 'Страницы PDF без текста (сканы): их содержимое не проверялось.',
  binary_files: 'Двоичные файлы (картинки, шрифты, архивы): их содержимое не разбиралось.',
};
const stackLabels: Record<string, string> = {
  nextjs: 'Next.js', nuxt: 'Nuxt', react: 'React', vue: 'Vue', svelte: 'Svelte', angular: 'Angular', vite: 'Vite', nestjs: 'NestJS', express: 'Express',
  tailwind: 'Tailwind CSS', prisma: 'Prisma', laravel: 'Laravel', wordpress: 'WordPress', django: 'Django', flask: 'Flask', fastapi: 'FastAPI', rails: 'Ruby on Rails',
  go: 'Go', spring: 'Spring Boot', flutter: 'Flutter', docker: 'Docker', static_html: 'HTML без сборки',
};
export const sourceKindLabels: Record<string, string> = { stage_file: 'Загруженный архив', repository: 'Подключённый репозиторий', public_repo: 'Открытый репозиторий GitHub' };

const secretKinds: Record<string, string> = { aws_access_key: 'AWS', github_token: 'GitHub', slack_token: 'Slack', stripe_live_key: 'Stripe', google_api_key: 'Google API', telegram_bot_token: 'Telegram' };

function secretKind(key: string): string {
  if (key === 'private_key') return tr('закрытый ключ');
  if (key === 'connection_string') return tr('пароль в адресе базы данных');
  return secretKinds[key] ?? key;
}

function findingView(finding: Finding) {
  const texts = findingTexts[finding.code] ?? { title: finding.code, explanation: '', remediation: '' };
  const params: Record<string, string | number> = { ...(finding.params ?? {}), ...(typeof finding.params?.kind === 'string' ? { kind: secretKind(finding.params.kind) } : {}) };
  if (typeof params.section === 'string') params.sectionLabel = tr(sectionLabels[params.section] ?? params.section);
  return {
    id: finding.id, code: finding.code, category: finding.category, categoryLabel: tr(categoryLabels[finding.category] ?? finding.category),
    severity: finding.severity, severityLabel: tr(severityLabels[finding.severity]), confidence: finding.confidence,
    title: tr(texts.title, params), explanation: tr(texts.explanation, params), remediation: tr(texts.remediation, params), evidence: finding.evidence,
  };
}

export function reportView(report: AnalysisReport) {
  return {
    type: report.type ?? 'code',
    document: report.document ? { ...report.document, sections: report.document.sections.map((item) => ({ ...item, label: tr(sectionLabels[item.key] ?? item.key) })) } : null,
    profile: report.profile, status: report.status, source: { ...report.source, kindLabel: tr(sourceKindLabels[report.source.kind] ?? report.source.kind) },
    summary: { ...report.summary, stack: report.summary.stack.map((item) => ({ ...item, label: tr(stackLabels[item.key] ?? item.key) })) },
    findings: report.findings.map(findingView),
    counts: { high: report.findings.filter((item) => item.severity === 'high').length, medium: report.findings.filter((item) => item.severity === 'medium').length, low: report.findings.filter((item) => item.severity === 'low').length, info: report.findings.filter((item) => item.severity === 'info').length },
    checks: report.checks.map((check) => ({ ...check, label: tr(checkLabels[check.key] ?? check.key), statusLabel: tr(checkStatusLabels[check.status]) })),
    skipped: report.skipped,
    unverified: report.unverified.map((key) => ({ key, text: tr(unverifiedLabels[key] ?? key) })),
    disclaimer: report.type === 'document'
      ? tr('Это проверка по словам и разделам, а не экспертиза: отсутствие находок не значит, что документ полный и без противоречий. Документ не менялся и не отправлялся в ИИ.')
      : tr('Это разбор по файлам, а не сертификат: отсутствие находок не гарантирует, что ошибок нет. Исходный код не менялся.'),
  };
}

const escapeMd = (value: string) => value.replace(/([\\`*_[\]<>|])/g, '\\$1');

export function reportMarkdown(projectName: string, run: { createdAt: Date; finishedAt: Date | null }, report: AnalysisReport): string {
  const view = reportView(report);
  const out: string[] = [];
  out.push(`# ${view.type === 'document' ? tr('Разбор документа: {0}', [escapeMd(projectName)]) : tr('Разбор кода: {0}', [escapeMd(projectName)])}`, '');
  out.push(`- ${tr('Источник')}: ${view.source.kindLabel} — ${escapeMd(view.source.label)}${view.source.revision ? ` (${escapeMd(view.source.revision)})` : ''}`);
  out.push(`- SHA-256: \`${view.source.sha256}\``, `- ${tr('Профиль проверки')}: ${view.profile}`, `- ${tr('Готово')}: ${(run.finishedAt ?? run.createdAt).toISOString()}`, '');
  out.push(`## ${tr('Коротко')}`, '');
  if (view.document) {
    out.push(tr('Слов: {0}, абзацев: {1}.', [view.document.words, view.document.paragraphs]));
    out.push(tr('Разделы: {0}.', [view.document.sections.map((item) => `${item.found ? '✓' : '✗'} ${item.label}`).join(', ')]));
  } else out.push(tr('Файлов: {0}, прочитано текстовых: {1}, строк: {2}.', [view.summary.files, view.summary.textFilesRead, view.summary.lines]));
  if (view.summary.stack.length) out.push(tr('Технологии: {0}.', [view.summary.stack.map((item) => item.label).join(', ')]));
  if (view.summary.languages.length) out.push(tr('Языки: {0}.', [view.summary.languages.slice(0, 8).map((item) => `${item.name} (${item.files})`).join(', ')]));
  if (view.summary.routes.length) out.push(tr('Страницы по именам файлов: {0}.', [view.summary.routes.slice(0, 30).join(', ')]));
  out.push('', `## ${tr('Находки')}`, '');
  if (!view.findings.length) out.push(tr('Находок нет.'));
  for (const finding of view.findings) {
    out.push(`### ${finding.severityLabel} · ${finding.categoryLabel}: ${escapeMd(finding.title)}`, '', escapeMd(finding.explanation), '', `**${tr('Что сделать')}:** ${escapeMd(finding.remediation)}`, '');
    out.push(`${tr('Где')}: ${finding.evidence.map((item) => (view.type === 'document' ? (item.line ? tr('абзац {0}', [item.line]) : escapeMd(item.path)) : `\`${item.path.replace(/`/g, "'")}${item.line ? `:${item.line}` : ''}\``)).join(', ')}`, '');
  }
  out.push(`## ${tr('Проверки')}`, '');
  for (const check of view.checks) out.push(`- ${check.label}: ${check.statusLabel}`);
  out.push('', `## ${tr('Не проверено')}`, '');
  for (const item of view.unverified) out.push(`- ${item.text}`);
  out.push('', `> ${view.disclaimer}`, '');
  return out.join('\n');
}
