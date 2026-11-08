import type { Locale } from '@/i18n/types';
import { DEFAULT_LOCALE } from '@/i18n/types';
import { createT } from '@/i18n/t';
import type { AppData, Attempt, Skill } from './types';
import { SKILLS } from './practice';

export const MASTERY_RULES = {
  /** Consecutive correct attempts required */
  consecutiveCorrect: 3,
  /** 连续答对区间至少覆盖的技能数 */
  minSkills: 2,
  /** 需要保持无错的天数 */
  errorFreeDays: 14,
  /** 连续答对区间至少分布的轮次数 */
  minRounds: 2,
} as const;

/** 缺少 roundId 的旧作答统一归入的「历史轮次」标识。 */
export const LEGACY_ROUND_ID = 'legacy';

const DAY_MS = 86_400_000;

export interface MasteryCheck {
  eligible: boolean;
  /** 从最新作答往前数的连续答对次数（遇错即止；只统计带 skill 的练习作答）。 */
  streak: number;
  /** 参与判定的连续答对区间覆盖的技能（按 SKILLS 固定顺序）。 */
  skills: Skill[];
  /** 参与判定的连续答对区间分布的轮次（按出现顺序，最新轮次在前）。 */
  roundIds: string[];
  /** 距最近一次答错的天数；从未答错时 = 距首次练习作答的天数；无作答 = 0。 */
  errorFreeDays: number;
  /** 未满足的原因（中文，可空）。 */
  reasons: string[];
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

/** 归一化时间戳：非法值回退到当前时间。 */
function normalizeNow(now?: number): number {
  return typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
}

/** 是否是合法的技能值（脏数据里可能有任意字符串）。 */
function isSkill(value: unknown): value is Skill {
  return typeof value === 'string' && (SKILLS as readonly string[]).includes(value);
}

/** 毫秒差折算天数，向下取整；负数（脏数据）按 0 处理。 */
function daysBetween(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.floor((to - from) / DAY_MS));
}

/**
 * 取某个词的练习作答（带合法 skill）。
 * 按时间倒序返回（新的在前）；时间相同时保持原数组顺序（AppData 中作答本身即按新的在前存储）。
 */
function practiceAttempts(data: AppData, wordId: string): Attempt[] {
  const attempts = Array.isArray(data?.attempts) ? (data.attempts as Attempt[]) : [];
  return attempts
    .filter(
      (attempt) => Boolean(attempt) && attempt.wordId === wordId && isSkill(attempt.skill),
    )
    .map((attempt) => ({
      ...attempt,
      createdAt:
        typeof attempt.createdAt === 'number' && Number.isFinite(attempt.createdAt)
          ? attempt.createdAt
          : 0,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** 轮次标识：缺失 / 非法 roundId 的旧作答合并为一个 legacy 轮次。 */
function roundIdOf(attempt: Attempt): string {
  const raw = attempt.roundId;
  if (typeof raw !== 'string') return LEGACY_ROUND_ID;
  const trimmed = raw.trim();
  return trimmed || LEGACY_ROUND_ID;
}

/* ------------------------------------------------------------------ */
/* 公开 API                                                            */
/* ------------------------------------------------------------------ */

/**
 * 判定某个词是否满足掌握条件。
 *
 * @param data 应用数据（只读）
 * @param wordId 目标词 id
 * @param now 当前时间（毫秒），缺省 Date.now()
 */
export function evaluateMastery(
  data: AppData,
  wordId: string,
  now?: number,
  locale: Locale = DEFAULT_LOCALE,
): MasteryCheck {
  const nowTs = normalizeNow(now);
  const t = createT(locale);
  const empty: MasteryCheck = {
    eligible: false,
    streak: 0,
    skills: [],
    roundIds: [],
    errorFreeDays: 0,
    reasons: [],
  };
  if (!data || typeof data !== 'object' || !wordId) return empty;

  const attempts = practiceAttempts(data, wordId);
  /** 已被手动 / 规则标记掌握：直接视为满足条件。 */
  const marked = Boolean(data.mastery && data.mastery[wordId]);

  if (attempts.length === 0) {
    return {
      eligible: marked,
      streak: 0,
      skills: [],
      roundIds: [],
      errorFreeDays: 0,
      reasons: marked ? [] : [t('domain.mastery.noAttempts')],
    };
  }

  // 1) 连续答对：从最新往前数，遇到错题即停。
  let streak = 0;
  for (const attempt of attempts) {
    if (!attempt.correct) break;
    streak += 1;
  }

  // 参与判定的区间 = 最近连续答对的至多 N 次。
  const window = attempts.slice(0, Math.min(streak, MASTERY_RULES.consecutiveCorrect));

  const windowSkills = new Set<Skill>();
  const roundIds: string[] = [];
  for (const attempt of window) {
    if (isSkill(attempt.skill)) windowSkills.add(attempt.skill);
    const roundId = roundIdOf(attempt);
    if (!roundIds.includes(roundId)) roundIds.push(roundId);
  }
  // 技能按 SKILLS 的固定顺序输出，仪表盘展示顺序稳定。
  const skills = SKILLS.filter((skill) => windowSkills.has(skill));

  // 3) 14 天无错：最近一次答错；从未答错则从首次练习作答算起。
  const wrongAt = attempts.filter((attempt) => !attempt.correct).map((a) => a.createdAt);
  const lastWrongAt = wrongAt.length > 0 ? Math.max(...wrongAt) : undefined;
  const firstAt = attempts[attempts.length - 1].createdAt;
  const errorFreeDays =
    lastWrongAt !== undefined ? daysBetween(lastWrongAt, nowTs) : daysBetween(firstAt, nowTs);

  const reasons: string[] = [];
  if (streak < MASTERY_RULES.consecutiveCorrect) {
    reasons.push(
      t('domain.mastery.streakProgress', {
        streak,
        remaining: MASTERY_RULES.consecutiveCorrect - streak,
      }),
    );
  }
  if (skills.length < MASTERY_RULES.minSkills) {
    reasons.push(
      t('domain.mastery.skillsCoverage', {
        window: window.length,
        count: skills.length,
        min: MASTERY_RULES.minSkills,
      }),
    );
  }
  if (roundIds.length < MASTERY_RULES.minRounds) {
    reasons.push(
      t('domain.mastery.roundsCoverage', {
        window: window.length,
        count: roundIds.length,
        min: MASTERY_RULES.minRounds,
      }),
    );
  }
  if (errorFreeDays < MASTERY_RULES.errorFreeDays) {
    reasons.push(
      lastWrongAt !== undefined
        ? t('domain.mastery.errorFreeSinceWrong', {
            days: errorFreeDays,
            required: MASTERY_RULES.errorFreeDays,
          })
        : t('domain.mastery.errorFreeSinceFirst', {
            days: errorFreeDays,
            required: MASTERY_RULES.errorFreeDays,
          }),
    );
  }

  return {
    eligible: marked || reasons.length === 0,
    streak,
    skills,
    roundIds,
    errorFreeDays,
    reasons: marked ? [] : reasons,
  };
}

/** 该词是否已掌握（仅看 mastery 映射）。规则判定请用 evaluateMastery。 */
export function isMastered(data: AppData, wordId: string): boolean {
  if (!data || typeof data !== 'object' || !wordId) return false;
  return Boolean(data.mastery?.[wordId]);
}
