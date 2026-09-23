/**
 * Site localization dictionary — the single source of truth for all user-facing UI strings.
 *
 * Russian ("ru") is the source of truth (the current live UI language); English ("en") is a natural
 * translation. Keys are flat, dot-namespaced by area (nav / dashboard / storyboard / auth / …).
 *
 * NEVER localize: image/video GENERATION prompts (imagePrompt, raw prompt text shown to the user) and
 * the brand name "Foltum Studio". Those are intentionally absent here.
 */

export type Locale = 'ru' | 'en'

export const LOCALES: Locale[] = ['ru', 'en']
export const DEFAULT_LOCALE: Locale = 'ru'

export const LOCALE_LABELS: Record<Locale, string> = {
  ru: 'Русский',
  en: 'English',
}

export function isLocale(v: unknown): v is Locale {
  return v === 'ru' || v === 'en'
}

/** Flat key → text. Both locales MUST carry the same key set. */
type Dict = Record<string, string>

const ru: Dict = {
  // ── common ──────────────────────────────────────────────────────────────
  'common.loading': 'Загрузка…',
  'common.save': 'Сохранить',
  'common.cancel': 'Отмена',
  'common.delete': 'Удалить',
  'common.close': 'Закрыть',
  'common.back': 'Назад',
  'common.next': 'Далее',
  'common.retry': 'Повторить',
  'common.download': 'Скачать',
  'common.language': 'Язык',

  // ── nav / header / account ──────────────────────────────────────────────
  'nav.signIn': 'Войти',
  'nav.getStarted': 'Начать',
  'nav.subscribe': 'Оформить подписку',
  'nav.plansCredits': 'Тарифы и кредиты',
  'nav.signOut': 'Выйти',
  'nav.activeSub': 'Активная подписка: {tier}',

  // ── dashboard ───────────────────────────────────────────────────────────
  'dashboard.yourProjects': 'Ваши проекты',
  'dashboard.subtitle': 'Создавайте фильмы и сериалы с ИИ из одного запроса',
  'dashboard.newProject': 'Новый проект',
  'dashboard.empty': 'Проектов пока нет. Создайте первый.',
  'dashboard.emptyTitle': 'Проектов пока нет',
  'dashboard.emptyHint': 'Создайте свой первый ИИ-фильм или сериал',
  'dashboard.createProject': 'Создать проект',
  'dashboard.untitled': 'Без названия',
  'dashboard.testBadge': 'Тест',
  'dashboard.created': 'Создан {date}',
  'dashboard.confirmDelete': 'Удалить проект?',
  'dashboard.confirmDeletePermanent': 'Удалить проект навсегда?',
  'dashboard.yesDelete': 'Да, удалить',
  'dashboard.delete': 'Удалить',
  'dashboard.deleting': 'Удаление…',
  'dashboard.deleteFailed': 'Не удалось удалить проект',
  'dashboard.paySuccess': 'Оплата прошла успешно! +{credits} кредитов начислено.',
  'dashboard.payDeclined': 'Платёж отклонён.',
  'dashboard.stage.synopsis': 'Синопсис',
  'dashboard.stage.characters': 'Персонажи',
  'dashboard.stage.structure': 'Структура',
  'dashboard.stage.scenes': 'Сцены и видео',

  // ── storyboard panel ────────────────────────────────────────────────────
  'storyboard.buildBoards': 'Разбить историю на кадры',
  'storyboard.rebuildBoards': 'Перестроить кадры',
  'storyboard.gatheringAssets': 'Сбор ассетов…',
  'storyboard.assemble': 'Собрать ролик (~90с)',
  'storyboard.assembleReady': 'Склеить клипы кадров в один ролик',
  'storyboard.assembleLocked': 'Доступно, когда все кадры оживлены',
  'storyboard.status': '{boards} кадров · {framed} с кадром · {animated} оживлено',
  'storyboard.statusAssembled': ' · ролик собран',
  'storyboard.assembledVideo': 'Собранный ролик',
  'storyboard.downloadMp4': 'Скачать mp4',
  'storyboard.loadingBoards': 'Загрузка кадров…',
  'storyboard.noBoards': 'Кадров пока нет. Нажмите «Разбить историю на кадры», чтобы сгенерировать раскадровку из готовой истории.',
  'storyboard.assets': 'Ассеты',
  'storyboard.assetsGenerating': 'Ассеты генерируются…',
  'storyboard.assetsHint': 'Недостающие референсы генерируются автоматически. Разбивка истории на кадры начнётся сама, как только все персонажи и локации будут готовы — это окно можно закрыть.',
  'storyboard.assetsCharacters': 'Персонажи',
  'storyboard.assetsLocations': 'Локации',
  'storyboard.assetsProps': 'Предметы',
  'storyboard.errBuild': 'Не удалось разбить историю на кадры',
  'storyboard.errBuildStart': 'Не удалось запустить разбиение',
  'storyboard.errAssemble': 'Не удалось собрать ролик',
  'storyboard.errAssembleStart': 'Не удалось запустить сборку',
  'storyboard.errRequest': 'Ошибка запроса',

  // ── board card ──────────────────────────────────────────────────────────
  'board.frame': 'Кадр {n}',
  'board.inFrame': 'В кадре',
  'board.entering': 'Входят',
  'board.exiting': 'Выходят',
  'board.generateFrame': 'Сгенерировать кадр',
  'board.regenerateFrame': 'Перегенерировать кадр',
  'board.animate': 'Оживить',
  'board.reanimate': 'Переанимировать',
  'board.frameDescription': 'Описание кадра',
  'board.details': 'Детали кадра',
  'board.frameLocked': 'Сначала сгенерируйте предыдущий кадр',
  'board.needFrameFirst': 'Сначала сгенерируйте кадр',
  'board.animateHint': 'Оживить кадр в клип 4–6с',
  'board.copy': 'Скопировать',
  'board.copied': 'Скопировано',
  'board.rebuildPrompt': 'Пересобрать',

  // ── auth ────────────────────────────────────────────────────────────────
  'auth.signInTitle': 'Вход',
  'auth.signUpTitle': 'Регистрация',
  'auth.email': 'Эл. почта',
  'auth.password': 'Пароль',
  'auth.name': 'Имя',
  'auth.signInBtn': 'Войти',
  'auth.signUpBtn': 'Зарегистрироваться',
  'auth.noAccount': 'Нет аккаунта?',
  'auth.haveAccount': 'Уже есть аккаунт?',
  'auth.signInSubtitle': 'Войдите, чтобы создавать фильмы с ИИ',
  'auth.signUpSubtitle': 'Создайте аккаунт, чтобы делать фильмы с ИИ',
  'auth.invalidCredentials': 'Неверная почта или пароль',
  'auth.somethingWrong': 'Что-то пошло не так',
  'auth.creating': 'Создание аккаунта…',
  'auth.fullName': 'Имя и фамилия',
  'auth.passwordMin': 'Пароль (мин. 6 символов)',
  'auth.createAccount': 'Создать аккаунт',
  'auth.signupFailed': 'Не удалось зарегистрироваться',
  'auth.signInAfterFail': 'Аккаунт создан, но вход не выполнен. Войдите вручную.',

  // ── pricing ─────────────────────────────────────────────────────────────
  'pricing.title': 'Тарифы и кредиты',
  'pricing.headingLead': 'Подписки и ',
  'pricing.headingHighlight': 'кредиты',
  'pricing.subtitle': 'Подписка открывает функции, но не даёт кредиты. Кредиты для генерации видео покупаются отдельно.',
  'pricing.balance': 'Текущий баланс:',
  'pricing.creditsUnit': 'кредитов',
  'pricing.subsHeading': 'Подписки — доступ к функциям',
  'pricing.subsSubtitle': 'Открывают функции редактора. Кредиты не начисляются.',
  'pricing.yourPlan': 'Ваш план',
  'pricing.mostPopular': 'Самый популярный',
  'pricing.active': 'Активен',
  'pricing.subscribe': 'Подписаться',
  'pricing.perMonth': '/мес',
  'pricing.creditsHeadingLead': 'Кредиты — ',
  'pricing.creditsHeadingHighlight': 'оплата генерации',
  'pricing.creditsRate': '1 кредит = 1 секунда видео. Например: 20 кредитов = 20 секунд.',
  'pricing.packUnit': '{credits} кредитов = {credits} секунд',
  'pricing.footnote': 'Подписка открывает функции, но не даёт кредиты. Кредиты для генерации видео покупаются отдельно.',
  'pricing.feat.ownFace': 'Своё лицо персонажа',
  'pricing.feat.promptEdit': 'Редактирование сцен промптом',
  'pricing.feat.manualPrompt': 'Ручная правка промпта',
  'pricing.feat.allBasic': 'Всё из Basic',
  'pricing.feat.premiumQuality': 'Премиум-качество (720p / 1080p)',
  'pricing.feat.allPro': 'Всё из Pro',
  'pricing.feat.maxAccess': 'Максимальный уровень доступа',
  'pricing.paidCredits': 'Оплата прошла успешно! Зачислено +{credits} кредитов.',
  'pricing.paidSub': 'Оплата прошла успешно! Подписка активирована.',
  'pricing.declined': 'Платёж отклонён.',
  'pricing.startFailed': 'Не удалось начать оплату',
  'pricing.payError': 'Ошибка оплаты. Попробуйте ещё раз.',
}

const en: Dict = {
  // ── common ──────────────────────────────────────────────────────────────
  'common.loading': 'Loading…',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.close': 'Close',
  'common.back': 'Back',
  'common.next': 'Next',
  'common.retry': 'Retry',
  'common.download': 'Download',
  'common.language': 'Language',

  // ── nav / header / account ──────────────────────────────────────────────
  'nav.signIn': 'Sign In',
  'nav.getStarted': 'Get Started',
  'nav.subscribe': 'Subscribe',
  'nav.plansCredits': 'Plans & Credits',
  'nav.signOut': 'Sign Out',
  'nav.activeSub': 'Active subscription: {tier}',

  // ── dashboard ───────────────────────────────────────────────────────────
  'dashboard.yourProjects': 'Your Projects',
  'dashboard.subtitle': 'Create AI-powered films and series from a single prompt',
  'dashboard.newProject': 'New Project',
  'dashboard.empty': 'No projects yet. Create your first one.',
  'dashboard.emptyTitle': 'No projects yet',
  'dashboard.emptyHint': 'Start your first AI film or series',
  'dashboard.createProject': 'Create Project',
  'dashboard.untitled': 'Untitled',
  'dashboard.testBadge': 'Test',
  'dashboard.created': 'Created {date}',
  'dashboard.confirmDelete': 'Delete this project?',
  'dashboard.confirmDeletePermanent': 'Delete the project permanently?',
  'dashboard.yesDelete': 'Yes, delete',
  'dashboard.delete': 'Delete',
  'dashboard.deleting': 'Deleting…',
  'dashboard.deleteFailed': "Couldn't delete the project",
  'dashboard.paySuccess': 'Payment successful! +{credits} credits added.',
  'dashboard.payDeclined': 'Payment was declined.',
  'dashboard.stage.synopsis': 'Synopsis',
  'dashboard.stage.characters': 'Characters',
  'dashboard.stage.structure': 'Structure',
  'dashboard.stage.scenes': 'Scenes & Video',

  // ── storyboard panel ────────────────────────────────────────────────────
  'storyboard.buildBoards': 'Split story into frames',
  'storyboard.rebuildBoards': 'Rebuild frames',
  'storyboard.gatheringAssets': 'Gathering assets…',
  'storyboard.assemble': 'Assemble video (~90s)',
  'storyboard.assembleReady': 'Stitch the frame clips into one video',
  'storyboard.assembleLocked': 'Available once every frame is animated',
  'storyboard.status': '{boards} frames · {framed} with a still · {animated} animated',
  'storyboard.statusAssembled': ' · video assembled',
  'storyboard.assembledVideo': 'Assembled video',
  'storyboard.downloadMp4': 'Download mp4',
  'storyboard.loadingBoards': 'Loading frames…',
  'storyboard.noBoards': 'No frames yet. Click “Split story into frames” to generate a storyboard from the finished story.',
  'storyboard.assets': 'Assets',
  'storyboard.assetsGenerating': 'Generating assets…',
  'storyboard.assetsHint': 'Missing references are generated automatically. Splitting the story into frames starts on its own once every character and location is ready — you can close this window.',
  'storyboard.assetsCharacters': 'Characters',
  'storyboard.assetsLocations': 'Locations',
  'storyboard.assetsProps': 'Props',
  'storyboard.errBuild': 'Failed to split the story into frames',
  'storyboard.errBuildStart': 'Failed to start the split',
  'storyboard.errAssemble': 'Failed to assemble the video',
  'storyboard.errAssembleStart': 'Failed to start assembly',
  'storyboard.errRequest': 'Request error',

  // ── board card ──────────────────────────────────────────────────────────
  'board.frame': 'Frame {n}',
  'board.inFrame': 'In frame',
  'board.entering': 'Entering',
  'board.exiting': 'Exiting',
  'board.generateFrame': 'Generate frame',
  'board.regenerateFrame': 'Regenerate frame',
  'board.animate': 'Animate',
  'board.reanimate': 'Re-animate',
  'board.frameDescription': 'Frame description',
  'board.details': 'Frame details',
  'board.frameLocked': 'Generate the previous frame first',
  'board.needFrameFirst': 'Generate the frame first',
  'board.animateHint': 'Animate the frame into a 4–6s clip',
  'board.copy': 'Copy',
  'board.copied': 'Copied',
  'board.rebuildPrompt': 'Rebuild',

  // ── auth ────────────────────────────────────────────────────────────────
  'auth.signInTitle': 'Sign In',
  'auth.signUpTitle': 'Sign Up',
  'auth.email': 'Email',
  'auth.password': 'Password',
  'auth.name': 'Name',
  'auth.signInBtn': 'Sign In',
  'auth.signUpBtn': 'Sign Up',
  'auth.noAccount': "Don't have an account?",
  'auth.haveAccount': 'Already have an account?',
  'auth.signInSubtitle': 'Sign in to create AI-powered films',
  'auth.signUpSubtitle': 'Create an account to make AI-powered films',
  'auth.invalidCredentials': 'Invalid email or password',
  'auth.somethingWrong': 'Something went wrong',
  'auth.creating': 'Creating account…',
  'auth.fullName': 'Full Name',
  'auth.passwordMin': 'Password (min 6 characters)',
  'auth.createAccount': 'Create Account',
  'auth.signupFailed': 'Signup failed',
  'auth.signInAfterFail': 'Account created but sign-in failed. Please log in.',

  // ── pricing ─────────────────────────────────────────────────────────────
  'pricing.title': 'Plans & Credits',
  'pricing.headingLead': 'Plans & ',
  'pricing.headingHighlight': 'credits',
  'pricing.subtitle': 'A subscription unlocks features but does not include credits. Credits for video generation are purchased separately.',
  'pricing.balance': 'Current balance:',
  'pricing.creditsUnit': 'credits',
  'pricing.subsHeading': 'Subscriptions — feature access',
  'pricing.subsSubtitle': 'They unlock editor features. No credits are granted.',
  'pricing.yourPlan': 'Your plan',
  'pricing.mostPopular': 'Most Popular',
  'pricing.active': 'Active',
  'pricing.subscribe': 'Subscribe',
  'pricing.perMonth': '/mo',
  'pricing.creditsHeadingLead': 'Credits — ',
  'pricing.creditsHeadingHighlight': 'pay per generation',
  'pricing.creditsRate': '1 credit = 1 second of video. For example: 20 credits = 20 seconds.',
  'pricing.packUnit': '{credits} credits = {credits} seconds',
  'pricing.footnote': 'A subscription unlocks features but does not include credits. Credits for video generation are purchased separately.',
  'pricing.feat.ownFace': 'Your own character face',
  'pricing.feat.promptEdit': 'Edit scenes via prompt',
  'pricing.feat.manualPrompt': 'Manual prompt editing',
  'pricing.feat.allBasic': 'Everything in Basic',
  'pricing.feat.premiumQuality': 'Premium quality (720p / 1080p)',
  'pricing.feat.allPro': 'Everything in Pro',
  'pricing.feat.maxAccess': 'Maximum access level',
  'pricing.paidCredits': 'Payment successful! +{credits} credits added.',
  'pricing.paidSub': 'Payment successful! Subscription activated.',
  'pricing.declined': 'Payment was declined.',
  'pricing.startFailed': 'Could not start the payment',
  'pricing.payError': 'Payment error. Please try again.',
}

export const DICTIONARIES: Record<Locale, Dict> = { ru, en }

/** Interpolate {placeholder} tokens with the provided params. */
export function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`))
}

/** Resolve a key for a locale with a Russian fallback, then the raw key as a last resort. */
export function translate(locale: Locale, key: string, params?: Record<string, string | number>): string {
  const dict = DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE]
  const raw = dict[key] ?? DICTIONARIES[DEFAULT_LOCALE][key] ?? key
  return interpolate(raw, params)
}
