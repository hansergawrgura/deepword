/** 通用工具函数：id、日期、随机、格式化、发音。 */

let idCounter = 0;

/** 生成短小且足够唯一的 id（不依赖 crypto.randomUUID 的兼容性）。 */
export function uid(prefix = 'id'): string {
  const rand = Math.random().toString(36).slice(2, 9);
  const time = Date.now().toString(36);
  idCounter = (idCounter + 1) % 1000;
  return `${prefix}_${time}${idCounter.toString(36)}${rand}`;
}

/** 本地日期的 YYYY-MM-DD。 */
export function dayKey(date: Date | number = new Date()): string {
  const d = typeof date === 'number' ? new Date(date) : date;
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(ts: number, days: number): number {
  return ts + days * 86_400_000;
}

/** 中文相对时间，适合列表展示。 */
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const days = Math.floor(diff / 86_400_000);
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

/** 距离到期还有多久 / 已逾期多久。 */
export function relativeDue(dueAt: number, now = Date.now()): string {
  const diff = dueAt - now;
  if (diff <= 0) {
    const overdue = Math.abs(diff);
    if (overdue < 3_600_000) return '已经到期';
    if (overdue < 86_400_000) return `逾期 ${Math.floor(overdue / 3_600_000)} 小时`;
    return `逾期 ${Math.floor(overdue / 86_400_000)} 天`;
  }
  if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))} 小时后`;
  return `${Math.round(diff / 86_400_000)} 天后`;
}

export function formatDate(ts: number = Date.now()): string {
  return new Date(ts).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function formatMonthDay(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

export function weekdayName(ts: number = Date.now()): string {
  return ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][
    new Date(ts).getDay()
  ];
}

/** Fisher–Yates，返回新数组。 */
export function shuffle<T>(items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 从数组中不重复地抽样 n 个。 */
export function sample<T>(items: readonly T[], n: number): T[] {
  return shuffle(items).slice(0, Math.max(0, n));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 百分比，保留整数。 */
export function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** 统一答案用于判分：去首尾空白、折叠空格、忽略大小写与结尾标点。 */
export function normalizeAnswer(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!。！?？,，;；:：'"]+$/g, '')
    .trim();
}

/** 本地语音朗读英文单词（不支持时静默）。 */
export function speak(text: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
  } catch {
    /* 忽略语音合成失败 */
  }
}

/** 词性中文化。 */
export function partOfSpeechZh(pos?: string): string {
  if (!pos) return '';
  const map: Record<string, string> = {
    n: '名词',
    v: '动词',
    vt: '及物动词',
    vi: '不及物动词',
    adj: '形容词',
    adv: '副词',
    prep: '介词',
    conj: '连词',
    pron: '代词',
    num: '数词',
    phr: '短语',
    phrase: '短语',
  };
  const key = pos.trim().toLowerCase().replace(/\./g, '');
  return map[key] ?? pos;
}

/** 截断文本。 */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 近似延迟展示。 */
export function formatLatency(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** 判断接口地址是否是本地/内网端点（本地模型通常允许空 API Key）。 */
export function isLocalEndpoint(url: string): boolean {
  try {
    const hostname = new URL(url.trim()).hostname.toLowerCase();
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal')
    );
  } catch {
    return false;
  }
}
