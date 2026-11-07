/**
 * Phase B 薄弱分析（6 个技能维度 + 最弱词）。
 *
 * 契约来源：docs/phase-b-contract.md 第 4 节。全部数据从作答记录现算，不落库：
 * - 只统计带 `skill` 的练习作答（互译用 `correct` 判定）；
 * - `skills` 固定 6 项，顺序同 practice.ts 的 SKILLS；
 * - `accuracy` 为 0~100 的整数，无作答时为 null；
 * - 薄弱度 = 错误次数 × 高权重 + 近期正确率低 + 最近作答久未复习；
 * - 掌握词不参与薄弱排名（它们不再需要复习）。
 *
 * 设计约束：纯函数、不读写 localStorage、不抛错；脏数据（缺 skill / 字段缺失 / 空词库）安全降级。
 */

import type { AppData, Attempt, Skill, Word } from './types';
import { SKILLS, SKILL_META } from './practice';
import { percent } from './utils';

export interface SkillStat {
  skill: Skill;
  label: string;
  attempts: number;
  correct: number;
  /** 百分整数；无作答为 null。 */
  accuracy: number | null;
  /** 最近一次该技能作答的时间戳。 */
  lastAt?: number;
}

export interface WeakWordStat {
  word: Word;
  attempts: number;
  accuracy: number | null;
  wrongCount: number;
  lastAt?: number;
}

export interface WeaknessReport {
  /** 固定 6 项，顺序同 SKILLS。 */
  skills: SkillStat[];
  /** 是否已有带 skill 的作答。 */
  practiced: boolean;
  weakestSkill: Skill | null;
  /** 最弱词，默认 ≤5，按薄弱度降序（只含有过错的词）。 */
  weakestWords: WeakWordStat[];
  /** 建议重点（一句中文）。 */
  focus: string;
}

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 每次答错的权重（与既有 stats.ts 的薄弱词口径保持一致量级）。 */
const WRONG_WEIGHT = 12;
/** 正确率每低 1 个百分点的权重。 */
const ACCURACY_WEIGHT = 0.25;
/** 最近作答久未复习：每多一天（上限 30 天）的权重。 */
const RECENCY_WEIGHT = 0.5;
/** 最近作答久远的天数上限，避免久到爆表。 */
const RECENCY_CAP_DAYS = 30;
/** 计算「近期正确率」时取最近多少次作答。 */
const RECENT_SAMPLE = 10;
/** 最弱词默认条数上限。 */
const DEFAULT_WEAK_WORD_LIMIT = 5;
/** 最弱词条数上限（防止脏数据传入超大 limit）。 */
const MAX_WEAK_WORD_LIMIT = 20;

const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

/** 归一化时间戳：非法值回退到当前时间。 */
function normalizeNow(now?: number): number {
  return typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
}

/** 归一化条数上限：非法值回退到默认，负数按 0 处理。 */
function normalizeLimit(limit: number | undefined, fallback = DEFAULT_WEAK_WORD_LIMIT): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return fallback;
  return Math.min(MAX_WEAK_WORD_LIMIT, Math.max(0, Math.floor(limit)));
}

/** 是否是合法的技能值（脏数据里可能有任意字符串）。 */
function isSkill(value: unknown): value is Skill {
  return typeof value === 'string' && (SKILLS as readonly string[]).includes(value);
}

/** 是否为参与统计的练习作答（带 skill）。 */
function isPracticeAttempt(attempt: Attempt | null | undefined): boolean {
  return Boolean(attempt) && isSkill(attempt!.skill);
}

/** 取全部练习作答（带 skill），按时间倒序。 */
function practiceAttempts(data: AppData): Attempt[] {
  const attempts = Array.isArray(data?.attempts) ? (data.attempts as Attempt[]) : [];
  return attempts
    .filter(isPracticeAttempt)
    .map((attempt) => ({
      ...attempt,
      createdAt:
        typeof attempt.createdAt === 'number' && Number.isFinite(attempt.createdAt)
          ? attempt.createdAt
          : 0,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** 某个词是否已掌握。 */
function isMasteredWord(data: AppData, wordId: string): boolean {
  return Boolean(data?.mastery?.[wordId]);
}

/** 取某个词的练习作答（时间倒序）。 */
function wordAttempts(data: AppData, wordId: string): Attempt[] {
  return practiceAttempts(data).filter((attempt) => attempt.wordId === wordId);
}

/* ------------------------------------------------------------------ */
/* 公开 API                                                            */
/* ------------------------------------------------------------------ */

/**
 * 各技能的正确率统计（固定 6 项，顺序同 SKILLS）。
 *
 * @param data 应用数据（只读）
 * @param now 当前时间（毫秒）；用于截断时钟漂移导致的未来时间戳，缺省 Date.now()
 */
export function getSkillStats(data: AppData, now?: number): SkillStat[] {
  const nowTs = normalizeNow(now);
  const stats: SkillStat[] = SKILLS.map((skill) => ({
    skill,
    label: SKILL_META[skill]?.label ?? skill,
    attempts: 0,
    correct: 0,
    accuracy: null,
  }));
  const indexOfSkill = new Map<Skill, number>(SKILLS.map((skill, index) => [skill, index]));

  for (const attempt of practiceAttempts(data)) {
    const skill = attempt.skill as Skill;
    const stat = stats[indexOfSkill.get(skill) as number];
    if (!stat) continue;
    stat.attempts += 1;
    if (attempt.correct) stat.correct += 1;
    if (typeof attempt.createdAt === 'number' && Number.isFinite(attempt.createdAt)) {
      // 时钟漂移产生的未来时间戳按 now 截断，避免「几天后」的负值。
      const at = Math.min(attempt.createdAt, nowTs);
      if (stat.lastAt === undefined || at > stat.lastAt) stat.lastAt = at;
    }
  }

  for (const stat of stats) {
    stat.accuracy = stat.attempts > 0 ? percent(stat.correct, stat.attempts) : null;
  }

  return stats;
}

/**
 * 生成薄弱分析报告。
 *
 * @param data 应用数据（只读）
 * @param options.limit 最弱词条数（默认 5）；options.now 当前时间
 */
export function getWeaknessReport(
  data: AppData,
  options: { limit?: number; now?: number } = {},
): WeaknessReport {
  const nowTs = normalizeNow(options.now);
  const limit = normalizeLimit(options?.limit);
  const skills = getSkillStats(data, nowTs);
  const practiced = skills.some((stat) => stat.attempts > 0);
  const weakestSkill = pickWeakestSkill(skills);
  const weakestWords = pickWeakWords(data, limit, nowTs);
  const focus = buildFocus(skills, weakestSkill, weakestWords, practiced);

  return { skills, practiced, weakestSkill, weakestWords, focus };
}

/**
 * 单词薄弱度，分越高越该复习（用于复习选词排序）。
 *
 * 构成：错误次数 × 高权重 + 近期正确率低 + 最近作答久远。
 * 掌握词返回 0（不再需要复习）。
 */
export function scoreWordWeakness(data: AppData, wordId: string, now?: number): number {
  const nowTs = normalizeNow(now);
  if (!data || typeof data !== 'object' || !wordId) return 0;
  if (isMasteredWord(data, wordId)) return 0;

  const attempts = wordAttempts(data, wordId);

  if (attempts.length === 0) {
    return 0;
  }

  const wrongCount = attempts.filter((attempt) => !attempt.correct).length;
  const recent = attempts.slice(0, RECENT_SAMPLE);
  const recentCorrect = recent.filter((attempt) => attempt.correct).length;
  const accuracy = percent(recentCorrect, recent.length);

  let score = wrongCount * WRONG_WEIGHT;
  score += (100 - accuracy) * ACCURACY_WEIGHT;

  const lastAt = attempts[0].createdAt;
  if (typeof lastAt === 'number' && Number.isFinite(lastAt)) {
    const days = Math.min(RECENCY_CAP_DAYS, Math.max(0, (nowTs - lastAt) / DAY_MS));
    score += days * RECENCY_WEIGHT;
  }

  return Math.round(score * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* 内部实现                                                            */
/* ------------------------------------------------------------------ */

/** 选出最弱技能：正确率最低；同分时作答次数少的更弱；再同分按 SKILLS 顺序。 */
function pickWeakestSkill(stats: SkillStat[]): Skill | null {
  const practiced = stats.filter((stat) => stat.attempts > 0 && stat.accuracy !== null);
  if (practiced.length === 0) return null;
  const sorted = [...practiced].sort((a, b) => {
    const accA = a.accuracy ?? 0;
    const accB = b.accuracy ?? 0;
    if (accA !== accB) return accA - accB;
    if (a.attempts !== b.attempts) return a.attempts - b.attempts;
    return SKILLS.indexOf(a.skill) - SKILLS.indexOf(b.skill);
  });
  return sorted[0].skill;
}

/**
 * 选出最弱词：只含有过错的词（从没错的词没有复习价值），
 * 掌握词不参与（已掌握即不再复习）。
 */
function pickWeakWords(data: AppData, limit: number, now: number): WeakWordStat[] {
  if (limit <= 0) return [];
  const words = Array.isArray(data?.words) ? (data.words as Word[]) : [];
  const wordMap = new Map<string, Word>();
  for (const word of words) {
    if (!word || typeof word !== 'object') continue;
    const id = typeof word.id === 'string' ? word.id : '';
    if (!id || wordMap.has(id)) continue;
    wordMap.set(id, word);
  }

  const byWord = new Map<string, Attempt[]>();
  for (const attempt of practiceAttempts(data)) {
    const list = byWord.get(attempt.wordId);
    if (list) list.push(attempt);
    else byWord.set(attempt.wordId, [attempt]);
  }

  const result: WeakWordStat[] = [];
  for (const [wordId, attempts] of byWord) {
    const word = wordMap.get(wordId);
    if (!word) continue;
    if (isMasteredWord(data, wordId)) continue;
    const wrongCount = attempts.filter((attempt) => !attempt.correct).length;
    if (wrongCount === 0) continue;
    const correct = attempts.filter((attempt) => attempt.correct).length;
    const lastAt = attempts[0].createdAt;
    result.push({
      word,
      attempts: attempts.length,
      accuracy: percent(correct, attempts.length),
      wrongCount,
      lastAt: typeof lastAt === 'number' && Number.isFinite(lastAt) ? lastAt : undefined,
    });
  }

  result.sort((a, b) => {
    const scoreA = scoreWordWeakness(data, a.word.id, now);
    const scoreB = scoreWordWeakness(data, b.word.id, now);
    if (scoreB !== scoreA) return scoreB - scoreA;
    if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount;
    const accA = a.accuracy ?? 0;
    const accB = b.accuracy ?? 0;
    if (accA !== accB) return accA - accB;
    const lastA = a.lastAt ?? 0;
    const lastB = b.lastAt ?? 0;
    if (lastA !== lastB) return lastA - lastB; // 越久远越靠前
    return a.word.id.localeCompare(b.word.id);
  });

  return result.slice(0, limit);
}

/** 生成一句中文建议重点。 */
function buildFocus(
  skills: SkillStat[],
  weakestSkill: Skill | null,
  weakWords: WeakWordStat[],
  practiced: boolean,
): string {
  if (!practiced || !weakestSkill) {
    return '还没有带技能标记的练习记录，先完成一轮练习（1 个新词 + 4~6 个复习词），就能看到你的薄弱项。';
  }

  const practicedStats = skills
    .filter((stat) => stat.attempts > 0 && stat.accuracy !== null)
    .sort((a, b) => {
      const accA = a.accuracy ?? 0;
      const accB = b.accuracy ?? 0;
      if (accA !== accB) return accA - accB;
      if (a.attempts !== b.attempts) return a.attempts - b.attempts;
      return SKILLS.indexOf(a.skill) - SKILLS.indexOf(b.skill);
    });

  const weakest = practicedStats[0];
  if (!weakest) {
    return '先完成一轮练习，我们就能告诉你该补哪一项。';
  }

  if ((weakest.accuracy ?? 0) >= 100) {
    return '各项技能正确率都不错，保持每天一轮的节奏，多认新词巩固即可。';
  }

  const second = practicedStats[1];
  const weakestAcc = weakest.accuracy ?? 0;
  // 次弱技能与最弱差距不大时一起点名，例：「听音与互译最弱」。
  const withSecond =
    Boolean(second) &&
    (second?.accuracy ?? 0) < 100 &&
    weakestAcc - (second?.accuracy ?? 0) <= 20;

  const names = withSecond ? `${weakest.label}与${second?.label}` : weakest.label;
  const parts: string[] = [`${names}最弱，先补 3 道${weakest.label}题`];
  if (withSecond) parts.push(`再加练 2 道${second?.label}题`);

  const worstWord = weakWords[0];
  if (worstWord) {
    const term = worstWord.word.term?.trim() || '这个词';
    parts.push(`重点复习「${term}」（错 ${worstWord.wrongCount} 次）`);
  }

  return `${parts.join('；')}。`;
}
