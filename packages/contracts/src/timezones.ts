/**
 * Часовые пояса объектов (ADR-009): проверка IANA-имени, подпись «Челябинск, UTC+5» и подсказка
 * пояса по адресу. Пояс браузера и сервера не читается нигде — только явные IANA-имена. Смещение
 * считается через `Intl` на заданный момент: если где-то вернут перевод часов, подпись будет верной.
 */

export interface TimezoneInfo {
  /** IANA-имя: `Asia/Yekaterinburg`. */
  readonly id: string;
  /** Название для списков и подписи по умолчанию: «Екатеринбург». */
  readonly name: string;
  /** Города и регионы, по которым пояс узнаётся в адресе (в нижнем регистре, «ё» → «е»). */
  readonly cities: readonly string[];
  /** Регионы: узнаются только перед словами «область», «край», «республика», «округ». */
  readonly regions?: readonly string[];
}

/**
 * Пояса России и соседних стран, где работают арендаторы и администраторы. Список для выбора в
 * форме и словарь подсказки по адресу; любой другой IANA-пояс тоже допустим (`isValidTimezone`).
 */
export const TIMEZONES: readonly TimezoneInfo[] = [
  {
    id: 'Europe/Kaliningrad',
    name: 'Калининград',
    cities: ['калининград', 'советск', 'черняховск'],
    regions: ['калининградская'],
  },
  {
    id: 'Europe/Moscow',
    name: 'Москва',
    cities: [
      'москва',
      'санкт-петербург',
      'петербург',
      'нижний новгород',
      'казань',
      'ростов-на-дону',
      'воронеж',
      'краснодар',
      'ярославль',
      'тула',
      'рязань',
      'тверь',
      'владимир',
      'иваново',
      'кострома',
      'смоленск',
      'брянск',
      'калуга',
      'орел',
      'курск',
      'белгород',
      'липецк',
      'тамбов',
      'пенза',
      'саранск',
      'чебоксары',
      'йошкар-ола',
      'киров',
      'вологда',
      'череповец',
      'архангельск',
      'мурманск',
      'петрозаводск',
      'сыктывкар',
      'великий новгород',
      'псков',
      'ставрополь',
      'махачкала',
      'грозный',
      'нальчик',
      'владикавказ',
      'сочи',
      'новороссийск',
      'симферополь',
      'севастополь',
      'химки',
      'подольск',
      'зеленоград',
    ],
    regions: [
      'московская',
      'ленинградская',
      'нижегородская',
      'ростовская',
      'воронежская',
      'краснодарский',
      'ярославская',
      'тульская',
      'рязанская',
      'тверская',
      'владимирская',
      'ивановская',
      'калужская',
      'смоленская',
      'брянская',
      'курская',
      'белгородская',
      'липецкая',
      'тамбовская',
      'пензенская',
      'кировская',
      'вологодская',
      'архангельская',
      'мурманская',
      'новгородская',
      'псковская',
      'ставропольский',
      'татарстан',
    ],
  },
  {
    id: 'Europe/Volgograd',
    name: 'Волгоград',
    cities: ['волгоград', 'волжский'],
    regions: ['волгоградская'],
  },
  {
    id: 'Europe/Samara',
    name: 'Самара',
    cities: ['самара', 'тольятти', 'сызрань', 'ижевск'],
    regions: ['самарская', 'удмуртская', 'удмуртия'],
  },
  { id: 'Europe/Ulyanovsk', name: 'Ульяновск', cities: ['ульяновск'], regions: ['ульяновская'] },
  {
    id: 'Europe/Saratov',
    name: 'Саратов',
    cities: ['саратов', 'энгельс'],
    regions: ['саратовская'],
  },
  { id: 'Europe/Astrakhan', name: 'Астрахань', cities: ['астрахань'], regions: ['астраханская'] },
  {
    id: 'Asia/Yekaterinburg',
    name: 'Екатеринбург',
    cities: [
      'екатеринбург',
      'челябинск',
      'магнитогорск',
      'миасс',
      'златоуст',
      'копейск',
      'нижний тагил',
      'каменск-уральский',
      'пермь',
      'тюмень',
      'тобольск',
      'уфа',
      'стерлитамак',
      'оренбург',
      'орск',
      'курган',
      'сургут',
      'нижневартовск',
      'ханты-мансийск',
      'салехард',
      'новый уренгой',
      'ноябрьск',
    ],
    regions: [
      'свердловская',
      'челябинская',
      'пермский',
      'тюменская',
      'башкортостан',
      'оренбургская',
      'курганская',
      'ханты-мансийский',
      'ямало-ненецкий',
    ],
  },
  { id: 'Asia/Omsk', name: 'Омск', cities: ['омск'], regions: ['омская'] },
  {
    id: 'Asia/Novosibirsk',
    name: 'Новосибирск',
    cities: ['новосибирск', 'бердск'],
    regions: ['новосибирская'],
  },
  { id: 'Asia/Barnaul', name: 'Барнаул', cities: ['барнаул', 'бийск'], regions: ['алтайский'] },
  { id: 'Asia/Tomsk', name: 'Томск', cities: ['томск', 'северск'], regions: ['томская'] },
  {
    id: 'Asia/Novokuznetsk',
    name: 'Кемерово',
    cities: ['кемерово', 'новокузнецк', 'прокопьевск'],
    regions: ['кемеровская', 'кузбасс'],
  },
  {
    id: 'Asia/Krasnoyarsk',
    name: 'Красноярск',
    cities: ['красноярск', 'норильск', 'абакан', 'кызыл'],
    regions: ['красноярский', 'хакасия', 'тыва'],
  },
  {
    id: 'Asia/Irkutsk',
    name: 'Иркутск',
    cities: ['иркутск', 'братск', 'ангарск', 'улан-удэ'],
    regions: ['иркутская', 'бурятия'],
  },
  { id: 'Asia/Chita', name: 'Чита', cities: ['чита'], regions: ['забайкальский'] },
  {
    id: 'Asia/Yakutsk',
    name: 'Якутск',
    cities: ['якутск', 'благовещенск'],
    regions: ['амурская', 'якутия', 'саха'],
  },
  {
    id: 'Asia/Vladivostok',
    name: 'Владивосток',
    cities: ['владивосток', 'находка', 'уссурийск', 'хабаровск', 'комсомольск-на-амуре'],
    regions: ['приморский', 'хабаровский'],
  },
  {
    id: 'Asia/Sakhalin',
    name: 'Южно-Сахалинск',
    cities: ['южно-сахалинск'],
    regions: ['сахалинская'],
  },
  { id: 'Asia/Magadan', name: 'Магадан', cities: ['магадан'], regions: ['магаданская'] },
  {
    id: 'Asia/Kamchatka',
    name: 'Петропавловск-Камчатский',
    cities: ['петропавловск-камчатский'],
    regions: ['камчатский'],
  },
  { id: 'Asia/Anadyr', name: 'Анадырь', cities: ['анадырь'], regions: ['чукотский'] },
  { id: 'Europe/Minsk', name: 'Минск', cities: ['минск', 'гомель', 'брест', 'гродно', 'витебск'] },
  { id: 'Asia/Almaty', name: 'Алматы', cities: ['алматы', 'астана', 'караганда', 'шымкент'] },
  { id: 'Asia/Tashkent', name: 'Ташкент', cities: ['ташкент', 'самарканд'] },
  { id: 'Asia/Bishkek', name: 'Бишкек', cities: ['бишкек'] },
  { id: 'Asia/Dushanbe', name: 'Душанбе', cities: ['душанбе'] },
  { id: 'Asia/Yerevan', name: 'Ереван', cities: ['ереван'] },
];

const BY_ID = new Map(TIMEZONES.map((t) => [t.id, t] as const));
let supported: ReadonlySet<string> | undefined;

/** IANA-пояс, известный `Intl` (DATA_MODEL: проверка по `Intl.supportedValuesOf('timeZone')`). */
export function isValidTimezone(tz: string): boolean {
  supported ??= new Set(Intl.supportedValuesOf('timeZone'));
  return supported.has(tz);
}

/** Смещение «UTC+5», «UTC+5:30», «UTC−6» на момент `at` (мс UTC). */
export function utcOffsetLabel(tz: string, at: number): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(part ?? '');
  if (!match) return 'UTC';
  const [, sign, hh, mm] = match;
  const hours = String(Number(hh));
  return `UTC${sign === '-' ? '−' : '+'}${hours}${mm === '00' ? '' : `:${mm}`}`;
}

/** Название пояса для подписи: из словаря или последняя часть IANA-имени. */
export function timezoneName(tz: string): string {
  return BY_ID.get(tz)?.name ?? (tz.split('/').pop() ?? tz).replaceAll('_', ' ');
}

/**
 * Подпись пояса к времени на экране: «Челябинск, UTC+5». `city` — город объекта (из адреса), если
 * известен и лежит в этом поясе; иначе — название пояса («Екатеринбург, UTC+5»).
 */
export function timezoneLabel(tz: string, at: number, city?: string | null): string {
  return `${city ?? timezoneName(tz)}, ${utcOffsetLabel(tz, at)}`;
}

export interface TimezoneSuggestion {
  readonly timezone: string;
  /** Как город записан в адресе, с заглавной: «Челябинск». */
  readonly city: string;
  /** Узнан город (надёжно) или только регион. */
  readonly matchedBy: 'city' | 'region';
}

const REGION_WORDS = /^(обл\.?|область|край|республика|респ\.?|округ|ао)$/;

function normalize(text: string): string {
  return text.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
}

function capitalize(words: string): string {
  return words.replace(
    /(^|[\s-])([а-я])/g,
    (_m, sep: string, ch: string) => sep + ch.toUpperCase(),
  );
}

/**
 * Подсказка пояса по адресу объекта: ищет в адресе город (целым словом) или регион рядом со словом
 * «область/край/республика». Город надёжнее региона: «г. Челябинск, ул. Московская» — Челябинск.
 * Это только подсказка для формы, пояс сам не подставляется (ADR-009).
 */
export function suggestTimezone(address: string | null | undefined): TimezoneSuggestion | null {
  if (!address) return null;
  const words = normalize(address)
    .split(/[\s,;()«»"]+/)
    .map((w) => w.replace(/^[.]+|[.]+$/g, ''))
    .filter((w) => w.length > 0);
  const text = ` ${words.join(' ')} `;
  let best: { tz: string; city: string; index: number } | undefined;
  for (const tz of TIMEZONES) {
    for (const city of tz.cities) {
      const index = text.indexOf(` ${city} `);
      if (index >= 0 && (best === undefined || index < best.index)) {
        best = { tz: tz.id, city, index };
      }
    }
  }
  if (best) return { timezone: best.tz, city: capitalize(best.city), matchedBy: 'city' };
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? '';
    if (!REGION_WORDS.test(words[i + 1] ?? '') && !REGION_WORDS.test(words[i - 1] ?? '')) continue;
    const tz = TIMEZONES.find((t) => t.regions?.includes(word));
    if (tz) return { timezone: tz.id, city: capitalize(word), matchedBy: 'region' };
  }
  return null;
}

/** Город объекта для подписи: из адреса, только если по словарю он в том же поясе. */
export function siteCity(address: string | null | undefined, tz: string): string | null {
  const suggestion = suggestTimezone(address);
  return suggestion?.matchedBy === 'city' && suggestion.timezone === tz ? suggestion.city : null;
}
