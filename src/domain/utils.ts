/** 通用工具函数：id、日期、随机、格式化。 */

let idCounter = 0;

export function uid(prefix = 'id'): string {
  const rand = Math.random().toString(36).slice(2, 9);
  const time = Date.now().toString(36);
  idCounter = (idCounter + 1) % 1000;
  return `${prefix}_${time}${idCounter.toString(36)}${rand}`;
}

export function dayKey(date: Date | number = new Date()): string {
  const d = typeof date === 'number' ? new Date(date) : date;
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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

export function shuffle<T>(items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function sample<T>(items: readonly T[], n: number): T[] {
  return shuffle(items).slice(0, Math.max(0, n));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function normalizeAnswer(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!。！?？,，;；:：'"]+$/g, '')
    .trim();
}

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

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function formatLatency(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

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
