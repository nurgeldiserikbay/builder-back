// Choice cards: decisions with consequences, explained for people who do not know development (STAGE_WORK_MODEL, section 24).

export type CardKey = 'code_hosting' | 'deployment' | 'domain';
/**
 * manual — the user does it and ticks it off; connect — form that checks a repository; download — files from the result package;
 * publish — publishing on BuildPath; push — send to the connected repository; package — files for an own server; verify — BuildPath opens the address and checks the site;
 * domain — form for the owner's domain with the DNS record to create and a check that it points at BuildPath.
 */
export type StepKind = 'manual' | 'connect' | 'download' | 'publish' | 'push' | 'package' | 'verify' | 'domain';

export interface ChoiceStep {
  key: string;
  title: string;
  text: string[];
  kind: StepKind;
  link?: { label: string; url: string };
}

export interface ChoiceOption {
  key: string;
  /** Another choice this option needs, e.g. GitHub Pages needs code on GitHub. */
  requires?: { card: CardKey; option: string; explanation: string };
  title: string;
  summary: string;
  pros: string[];
  limits: string[];
  cost: string;
  upkeep: string;
  leaving: string;
  steps: ChoiceStep[];
}

export interface ChoiceCard {
  key: CardKey;
  version: string;
  /** Date the facts about providers were last checked. */
  checkedAt: string;
  title: string;
  question: string;
  why: string;
  options: ChoiceOption[];
}

const tokenWarning = 'Ключ даёт доступ только к одному репозиторию. BuildPath хранит его в зашифрованном виде и никому не показывает — ни специалистам, ни ИИ. Отозвать ключ можно в любой момент там же, где вы его создали.';

export const choiceCards: Record<CardKey, ChoiceCard> = {
  code_hosting: {
    key: 'code_hosting',
    version: '1.0.0',
    checkedAt: '2026-11-10',
    title: 'Где хранить код',
    question: 'Где будут лежать файлы вашего сайта, кроме BuildPath?',
    why: 'Копия кода у вас — это страховка: сайт можно перенести на другой хостинг, отдать разработчику или восстановить. Сайт на BuildPath работает и без этого шага.',
    options: [
      {
        key: 'archive',
        title: 'Скачать архив',
        summary: 'Скачиваете файлы сайта и проекта себе на телефон или компьютер, когда нужно.',
        pros: ['Ничего не нужно настраивать', 'Не нужен аккаунт на другом сервисе'],
        limits: ['Копию нужно скачивать заново после каждого изменения', 'Нет истории изменений', 'Разработчику придётся пересылать файлы'],
        cost: 'Бесплатно',
        upkeep: 'Скачивать новую версию после изменений',
        leaving: 'Файлы и так у вас',
        steps: [
          { key: 'download', kind: 'download', title: 'Скачайте файлы', text: ['На странице проекта в блоке «Результат» нажмите «Подготовить файлы» и скачайте их.', 'Сохраните файлы туда, где не потеряете: в облако или на почту себе.'] },
        ],
      },
      {
        key: 'github',
        title: 'GitHub',
        summary: 'Самый популярный сервис для хранения кода. BuildPath будет отправлять туда принятую версию по вашей кнопке.',
        pros: ['История всех версий', 'Разработчики умеют с ним работать', 'Можно подключить хостинг, который берёт сайт прямо оттуда'],
        limits: ['Нужен аккаунт на github.com (на английском)', 'Ключ доступа нужно продлевать: максимум раз в год'],
        cost: 'Бесплатно для личных и закрытых репозиториев',
        upkeep: 'Продлить ключ доступа, когда истечёт срок',
        leaving: 'Легко: репозиторий можно скачать целиком или перенести в другой сервис',
        steps: [
          { key: 'account', kind: 'manual', title: 'Создайте аккаунт', text: ['Откройте github.com и нажмите «Sign up». Подойдёт любая почта.', 'Если аккаунт уже есть — просто войдите.'], link: { label: 'Открыть github.com', url: 'https://github.com/signup' } },
          { key: 'repository', kind: 'manual', title: 'Создайте пустой репозиторий', text: ['Нажмите «+» вверху справа → «New repository».', 'Название — латиницей, например «my-site». Выберите «Private», чтобы код видели только вы.', 'Ничего больше не отмечайте и нажмите «Create repository». Скопируйте адрес страницы — он понадобится на последнем шаге.'], link: { label: 'Новый репозиторий', url: 'https://github.com/new' } },
          { key: 'token', kind: 'manual', title: 'Создайте ключ доступа только к этому репозиторию', text: ['Откройте «Settings» → «Developer settings» → «Personal access tokens» → «Fine-grained tokens» → «Generate new token».', 'Срок — 90 дней или больше. В «Repository access» выберите «Only select repositories» и ваш репозиторий.', 'В «Permissions» → «Repository permissions» поставьте «Contents: Read and write». Остальное не трогайте.', 'Нажмите «Generate token» и скопируйте ключ — его покажут один раз.', tokenWarning], link: { label: 'Создать ключ', url: 'https://github.com/settings/personal-access-tokens/new' } },
          { key: 'connect', kind: 'connect', title: 'Подключите репозиторий', text: ['Вставьте адрес репозитория и ключ. BuildPath проверит, что может записывать в репозиторий, и ничего не отправит без вашего подтверждения.'] },
        ],
      },
      {
        key: 'gitlab',
        title: 'GitLab',
        summary: 'Похож на GitHub. Подходит, если вы или ваш разработчик уже пользуетесь GitLab или у компании свой сервер GitLab.',
        pros: ['История всех версий', 'Можно на своём сервере компании', 'Разработчики умеют с ним работать'],
        limits: ['Нужен аккаунт на gitlab.com или свой сервер', 'Ключ проекта действует не больше года'],
        cost: 'Бесплатно на gitlab.com для небольших проектов; свой сервер — по цене сервера',
        upkeep: 'Продлить ключ доступа, когда истечёт срок',
        leaving: 'Легко: проект можно экспортировать или перенести',
        steps: [
          { key: 'account', kind: 'manual', title: 'Войдите в GitLab', text: ['Откройте gitlab.com или адрес сервера вашей компании и войдите.'], link: { label: 'Открыть gitlab.com', url: 'https://gitlab.com/users/sign_up' } },
          { key: 'repository', kind: 'manual', title: 'Создайте пустой проект', text: ['Нажмите «New project» → «Create blank project».', 'Название — латиницей. «Visibility Level» — «Private».', 'Снимите отметку «Initialize repository with a README» и нажмите «Create project». Скопируйте адрес страницы проекта.'] },
          { key: 'token', kind: 'manual', title: 'Создайте ключ проекта', text: ['В проекте откройте «Settings» → «Access tokens» → «Add new token».', 'Роль — «Developer», права — «api». Срок — до года.', 'Нажмите «Create project access token» и скопируйте ключ.', tokenWarning] },
          { key: 'connect', kind: 'connect', title: 'Подключите проект', text: ['Вставьте адрес проекта и ключ. BuildPath проверит доступ и ничего не отправит без вашего подтверждения.'] },
        ],
      },
    ],
  },
  deployment: {
    key: 'deployment',
    version: '1.3.0',
    checkedAt: '2026-11-10',
    title: 'Где будет работать сайт',
    question: 'Где разместить сайт, чтобы его видели клиенты?',
    why: 'Сайт должен где-то работать круглосуточно. Проще всего — на BuildPath. Если нужен свой адрес на своём сервере или в другом сервисе, мы проведём по шагам и проверим, что сайт открывается.',
    options: [
      {
        key: 'buildpath',
        title: 'На BuildPath',
        summary: 'Сайт открывается по адресу вида имя.buildpath. Публикуете одной кнопкой, обновляете так же.',
        pros: ['Ничего не нужно настраивать', 'Работают форма заявок и онлайн-запись с уведомлениями в Telegram и на почту', 'HTTPS и резервные копии — наша забота'],
        limits: ['Адрес на поддомене BuildPath. Свой домен можно подключить в решении «Адрес сайта»'],
        cost: 'Входит в тариф',
        upkeep: 'Ничего',
        leaving: 'Легко: файлы сайта можно скачать или отправить в репозиторий',
        steps: [
          { key: 'publish', kind: 'publish', title: 'Опубликуйте сайт', text: ['На странице проекта в блоке «Публикация» выберите адрес и нажмите «Опубликовать». Сначала примите этап «Сборка и проверка».'] },
          { key: 'verify', kind: 'verify', title: 'Проверка', text: ['BuildPath сам проверит, что сайт опубликован и открывается последняя принятая версия.'] },
        ],
      },
      {
        key: 'github_pages',
        title: 'GitHub Pages',
        requires: { card: 'code_hosting', option: 'github', explanation: 'Сначала выберите GitHub в решении «Где хранить код» и подключите репозиторий.' },
        summary: 'Бесплатный хостинг от GitHub: сайт берётся прямо из вашего репозитория.',
        pros: ['Бесплатно', 'Адрес вида имя.github.io или свой домен', 'Новая версия — отправкой в репозиторий'],
        limits: ['Бесплатно только для открытого репозитория — код увидят все', 'Форма заявок и онлайн-запись BuildPath там не работают: на сайте останутся кнопки звонка и мессенджера', 'Нужен аккаунт GitHub'],
        cost: 'Бесплатно для открытых репозиториев; для закрытых — платный тариф GitHub',
        upkeep: 'Отправлять новую версию в репозиторий после изменений',
        leaving: 'Легко: файлы в вашем репозитории',
        steps: [
          { key: 'push', kind: 'push', title: 'Отправьте сайт в репозиторий', text: ['В решении «Где хранить код» нажмите «Отправить в репозиторий». В репозитории должен появиться файл index.html.'] },
          { key: 'pages', kind: 'manual', title: 'Включите GitHub Pages', text: ['В репозитории откройте «Settings» → «Pages».', 'В «Build and deployment» выберите «Deploy from a branch», ветку main и папку «/ (root)», нажмите «Save».', 'Через 1–2 минуты вверху появится адрес сайта — скопируйте его.'] },
          { key: 'verify', kind: 'verify', title: 'Проверьте адрес', text: ['Вставьте адрес сайта. BuildPath откроет его и сравнит с последней принятой версией.'] },
        ],
      },
      {
        key: 'own_server',
        title: 'Свой сервер',
        summary: 'Сайт работает на вашем сервере (VPS) с вашим доменом. Мы дадим готовые файлы и команды.',
        pros: ['Свой домен и полный контроль', 'Можно выбрать сервер в Казахстане', 'Подходит, если сервер уже есть'],
        limits: ['Нужно арендовать сервер и купить домен', 'Обновлять сервер, делать копии записей и следить за ним — ваша задача или вашего специалиста', 'Форма заявок BuildPath там не работает. Онлайн-запись работает через программу из пакета: записи хранятся на вашем сервере, а не в BuildPath'],
        cost: 'Сервер — обычно от 2 000–5 000 ₸ в месяц, домен — от 3 000 ₸ в год (цены у разных хостингов отличаются)',
        upkeep: 'Продлевать сервер и домен, ставить обновления',
        leaving: 'Легко: файлы у вас',
        steps: [
          { key: 'server', kind: 'manual', title: 'Арендуйте сервер', text: ['У любого хостинга возьмите VPS с Ubuntu 24.04: 1 ядро и 1 ГБ памяти достаточно.', 'Сохраните адрес сервера (IP) и пароль или ключ входа, которые пришлёт хостинг.'] },
          { key: 'domain', kind: 'manual', title: 'Направьте домен на сервер', text: ['У регистратора домена откройте настройки DNS и добавьте запись типа A: имя «@» (или поддомен), значение — IP сервера.', 'Изменение начинает работать за 5–60 минут.'] },
          { key: 'package', kind: 'package', title: 'Скачайте файлы для сервера', text: ['В пакете: страница сайта, файл настроек веб-сервера Caddy (сам получит HTTPS-сертификат) и инструкция с командами. Для сайта с онлайн-записью — ещё программа записи с вашим расписанием и страница записей для вас.', 'Если у вас есть специалист, просто передайте ему пакет.'] },
          { key: 'install', kind: 'manual', title: 'Запустите на сервере', text: ['Подключитесь к серверу и выполните команды из файла README.md в пакете — их можно скопировать целиком.', 'Если что-то пошло не так, пришлите текст ошибки специалисту или в поддержку.'] },
          { key: 'verify', kind: 'verify', title: 'Проверьте адрес', text: ['Вставьте адрес сайта, например https://ваш-домен.kz. BuildPath откроет его и сравнит с последней принятой версией.'] },
        ],
      },
    ],
  },
  domain: {
    key: 'domain',
    version: '1.0.0',
    checkedAt: '2026-11-11',
    title: 'Адрес сайта',
    question: 'По какому адресу клиенты будут открывать сайт?',
    why: 'Адрес BuildPath работает сразу и бесплатно. Свой домен проще запомнить и он остаётся вашим, даже если вы переедете на другой хостинг. Его можно подключить в любой момент — старый адрес BuildPath тоже продолжит работать.',
    options: [
      {
        key: 'buildpath_address',
        title: 'Адрес BuildPath',
        summary: 'Адрес вида имя.buildpath — выбираете имя при публикации.',
        pros: ['Бесплатно и сразу', 'HTTPS включён', 'Ничего не нужно продлевать'],
        limits: ['В адресе есть BuildPath', 'При переезде на другой хостинг адрес сменится'],
        cost: 'Бесплатно',
        upkeep: 'Ничего',
        leaving: 'Адрес остаётся на BuildPath; при переезде понадобится новый',
        steps: [
          { key: 'publish', kind: 'publish', title: 'Выберите имя и опубликуйте', text: ['На странице проекта в блоке «Публикация» впишите имя латиницей и нажмите «Опубликовать».'] },
        ],
      },
      {
        key: 'own_domain',
        title: 'Свой домен',
        requires: { card: 'deployment', option: 'buildpath', explanation: 'Здесь подключается домен к сайту на BuildPath. Если сайт работает на своём сервере или GitHub Pages, домен настраивается в шагах решения «Где будет работать сайт».' },
        summary: 'Адрес вроде barber-usy.com. Покупаете у регистратора и направляете на BuildPath одной записью в настройках.',
        pros: ['Короткий и запоминающийся адрес', 'Домен ваш: при переезде на другой хостинг он переезжает с вами', 'HTTPS BuildPath включит сам'],
        limits: [
          'Домен нужно купить и продлевать каждый год, иначе сайт перестанет открываться',
          'Домены .kz и .қаз по правилам Казахстана должны работать на серверах в Казахстане. Если BuildPath сейчас не размещает сайты в Казахстане, такой домен не подключится — выберите .com или другой, или разместите сайт на своём сервере в Казахстане',
          'Почта на домене (info@ваш-домен) настраивается отдельно у регистратора или почтового сервиса',
        ],
        cost: 'Домен — обычно несколько тысяч тенге в год, цена зависит от зоны и регистратора. Подключение в BuildPath бесплатно',
        upkeep: 'Продлевать домен у регистратора (удобно включить автопродление)',
        leaving: 'Легко: домен ваш, достаточно направить его на новый хостинг',
        steps: [
          { key: 'buy', kind: 'manual', title: 'Купите домен', text: ['Купите домен у любого регистратора: казахстанского (например, PS.kz, Hoster.kz) или международного.', 'Проверьте, что имя свободно, и оплатите на год или больше. Сохраните вход в личный кабинет регистратора — он понадобится на следующем шаге.', 'Если домен уже есть — этот шаг пропустите.'] },
          { key: 'connect', kind: 'domain', title: 'Направьте домен на BuildPath', text: ['Впишите домен ниже. BuildPath покажет одну-две записи DNS, которые нужно добавить у регистратора в разделе «DNS» или «Управление зоной».', 'Для www.ваш-домен нужна запись CNAME, для адреса без www — запись A. Изменение начинает работать за 5–60 минут, иногда до суток.', 'Потом нажмите «Проверить»: BuildPath сам убедится, что домен смотрит на сайт, и включит HTTPS.'] },
        ],
      },
    ],
  },
};

/** Deterministic recommendation with the reason shown to the user. */
export function recommend(card: CardKey, project: { hasSpecialists: boolean }): { optionKey: string; reason: string } {
  if (card === 'domain') {
    return { optionKey: 'buildpath_address', reason: 'Начните с бесплатного адреса BuildPath: сайт заработает сразу. Свой домен можно подключить позже, ничего не переделывая.' };
  }
  if (card === 'deployment') {
    return { optionKey: 'buildpath', reason: 'Это самый простой вариант: публикация одной кнопкой, работают форма заявок и онлайн-запись, а обслуживание сервера — наша забота.' };
  }
  return project.hasSpecialists
      ? { optionKey: 'github', reason: 'В проекте работают специалисты: им удобнее брать код из GitHub, и у вас будет история всех версий.' }
      : { optionKey: 'archive', reason: 'Сайт уже работает на BuildPath, а копия нужна на случай переезда. Архива достаточно, пока вы не подключаете разработчика.' };
}

/**
 * When the GitHub app is configured, the owner signs in instead of creating a repository and a key by hand.
 * The key-based steps stay available on the page as a fallback.
 */
export const githubOauthSteps: ChoiceStep[] = [
  { key: 'account', kind: 'manual', title: 'Аккаунт на GitHub', text: ['Если аккаунта нет, его можно создать бесплатно прямо на странице входа GitHub на следующем шаге.'], link: { label: 'Открыть github.com', url: 'https://github.com/signup' } },
  { key: 'connect', kind: 'connect', title: 'Войдите через GitHub и выберите репозиторий', text: ['Нажмите «Войти через GitHub», на странице GitHub — «Authorize». Затем создайте новый закрытый репозиторий одной кнопкой или выберите существующий.', 'BuildPath ничего не отправит без вашего подтверждения.'] },
];
