import { parseTableText } from '@oxrana/contracts';
import { normalizePlate } from '@oxrana/plates';

/**
 * Несколько номеров в одной строке (7b.2): пользователь вставил «А123ВС174 В456НР174 …» через пробел
 * или запятую, и вся строка стала бы одним неверным номером. Здесь такие строки распознаются, а
 * вставленный текст разбивается по строкам одним нажатием. Пробелы внутри одного номера
 * («А 123 ВС 174») по-прежнему допустимы — номер собирается из подряд идущих слов.
 */

/** Не больше стольких слов на один номер: «А 123 ВС 174» — четыре. */
const MAX_WORDS_PER_PLATE = 6;

/** Слова ячейки: пробелы, запятые и точки с запятой разделяют. */
const wordsOf = (cell: string): string[] => cell.split(/[\s,;]+/).filter((w) => w !== '');

/**
 * Ячейка целиком из полных номеров → список номеров (как написаны, слова склеены через пробел).
 * Берётся самая короткая группа слов, которая сама является распознанным номером; хоть одно слово
 * лишнее («фура», «Volvo») — это не список номеров, `null`.
 */
export function platesInCell(cell: string): string[] | null {
  const words = wordsOf(cell);
  if (words.length === 0) return null;
  const plates: string[] = [];
  let at = 0;
  while (at < words.length) {
    let found = 0;
    for (let size = 1; size <= Math.min(MAX_WORDS_PER_PLATE, words.length - at); size++) {
      const group = words.slice(at, at + size);
      if (normalizePlate(group.join('')).recognized) {
        found = size;
        break;
      }
    }
    if (found === 0) return null;
    plates.push(words.slice(at, at + found).join(' '));
    at += found;
  }
  return plates;
}

/** Строка таблицы, в которой стоит несколько номеров. */
export interface MultiPlateLine {
  /** Номер строки в таблице (с 1) — как в предпросмотре. */
  readonly line: number;
  readonly plates: readonly string[];
  /** Остальные ячейки строки (тип, марка…): достаются каждому номеру. */
  readonly rest: readonly string[];
}

/**
 * Строки, где подряд несколько полных номеров: либо в первой ячейке (через пробелы или запятые),
 * либо во всех непустых ячейках строки (запятые стали разделителями колонок). Строка с одним номером
 * и строка, где рядом с номерами есть чужие слова, не считаются.
 */
export function findMultiPlateLines(text: string): MultiPlateLine[] {
  const found: MultiPlateLine[] = [];
  parseTableText(text).forEach((cells, index) => {
    const first = platesInCell(cells[0] ?? '');
    if (!first) return;
    const filled = cells.filter((c) => c.trim() !== '');
    // запятые разнесли номера по колонкам: «А123ВС174, В456НР174» → две ячейки, обе — номера
    const allPlates = filled.map((c) => platesInCell(c));
    if (filled.length > 1 && allPlates.every((p) => p !== null)) {
      const plates = allPlates.flatMap((p) => p ?? []);
      if (plates.length > 1) found.push({ line: index + 1, plates, rest: [] });
      return;
    }
    if (first.length > 1) found.push({ line: index + 1, plates: first, rest: cells.slice(1) });
  });
  return found;
}

/** Текст, где каждая такая строка заменена строками по одному номеру (остальные ячейки — каждому). */
export function splitMultiPlateLines(text: string): string {
  const multi = new Map(findMultiPlateLines(text).map((m) => [m.line, m]));
  if (multi.size === 0) return text;
  const lines: string[] = [];
  parseTableText(text).forEach((cells, index) => {
    const m = multi.get(index + 1);
    if (!m) {
      lines.push(cells.join('\t'));
      return;
    }
    for (const plate of m.plates) lines.push([plate, ...m.rest].join('\t'));
  });
  return lines.join('\n');
}

/** Фраза-предложение под полем ввода: одна строка — «в строке 55 номеров», несколько — со счётом. */
export function multiPlateQuestion(lines: readonly MultiPlateLine[]): string {
  if (lines.length === 1 && lines[0]) {
    return `Похоже, в строке ${lines[0].plates.length} номеров — разбить по строкам?`;
  }
  const total = lines.reduce((sum, l) => sum + l.plates.length, 0);
  return `Похоже, в ${lines.length} строках по несколько номеров (всего ${total}) — разбить по строкам?`;
}
