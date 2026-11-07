/**
 * 设置页：多 provider 管理 + 数据管理 + 外观 + 关于。
 *
 * Provider 的增删改 / 切换当前使用只通过 useApp().actions 写入；
 * 列表与编辑表单的展示逻辑拆到 components/providers/ 下。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/AppState';
import type {
  AppData,
  PracticeSettings,
  ProviderDraft,
  ProviderProfile,
  ThemeMode,
  TtsSettings,
} from '../types';
import { DEFAULT_PRACTICE_SETTINGS, MAX_PROVIDERS } from '../types';
import { exportBackup, getStorageUsage, parseBackup } from '../lib/storage';
import {
  findActiveProvider,
  providerName,
  providerSummaryText,
  resolveActiveLLMSettings,
} from '../lib/providerModel';
import { useEnglishVoices } from '../lib/tts';
import { PROMPT_VERSION } from '../lib/llm';
import { APP_VERSION } from '../lib/version';
import { clamp, cx, isLocalEndpoint } from '../lib/utils';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { IconCheck, IconDownload, IconPlus, IconSparkle, IconUpload } from './ui/icons';
import ProviderEditor from './providers/ProviderEditor';
import ProviderList from './providers/ProviderList';
import { thinkingModeLabel } from './providers/draft';
import './Settings.css';

type EditorState = { mode: 'create' } | { mode: 'edit'; id: string };
type DialogKind = 'import' | 'clear-progress' | 'reset-all' | null;

/** 每词题量可选值（4~8）。 */
const QUESTIONS_PER_WORD_OPTIONS = [4, 5, 6, 7, 8];
/** 每轮复习词数可选值（4~6）。 */
const REVIEW_WORDS_OPTIONS = [4, 5, 6];
/** 每轮新词数可选值（1~10）。 */
const NEW_WORDS_OPTIONS = Array.from({ length: 10 }, (_, index) => index + 1);
/** 答对后自动跳转：毫秒，0 = 手动。 */
const AUTO_ADVANCE_OPTIONS = [
  { value: 3_000, label: '3 秒' },
  { value: 5_000, label: '5 秒' },
  { value: 0, label: '手动' },
];

function downloadJson(filename: string, content: string) {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function SettingsView() {
  const { data, actions } = useApp();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProviderProfile | null>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [pendingImport, setPendingImport] = useState<AppData | null>(null);
  const [importError, setImportError] = useState('');
  const [includeKey, setIncludeKey] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  // 英文语音列表：浏览器可能在首次加载后才拿到 voices，Hook 内部监听 voiceschanged。
  const voices = useEnglishVoices();

  const usage = useMemo(() => getStorageUsage(), [data.updatedAt]);
  const activeProfile = useMemo(() => findActiveProvider(data), [data]);
  const activeSettings = resolveActiveLLMSettings(data);
  const activeIndex = activeProfile
    ? data.providers.findIndex((item) => item.id === activeProfile.id)
    : 0;
  const configured = activeSettings
    ? Boolean(activeSettings.baseUrl.trim() && activeSettings.model.trim())
    : false;
  const needsKey = activeSettings
    ? !activeSettings.apiKey.trim() &&
      (activeSettings.provider === 'anthropic' || !isLocalEndpoint(activeSettings.baseUrl))
    : false;
  const aiReady = configured && !needsKey;
  const aiStatusLabel = !activeSettings
    ? '尚未配置模型'
    : !configured
      ? '配置待补全'
      : needsKey
        ? '待填写 API Key'
        : 'AI 已就绪';
  const atLimit = data.providers.length >= MAX_PROVIDERS;
  const editingProfile =
    editor?.mode === 'edit'
      ? (data.providers.find((item) => item.id === editor.id) ?? null)
      : null;

  /* ------------------------- 练习设置（Phase B） ------------------------- */
  // 兜底合并默认值，保证 tts 的三个字段始终齐全（旧数据可能缺字段）。
  const practice: PracticeSettings = {
    ...DEFAULT_PRACTICE_SETTINGS,
    ...data.practice,
    tts: { ...DEFAULT_PRACTICE_SETTINGS.tts, ...data.practice?.tts },
  };
  // 复习词数固定在 4~6；复习题量必须落在 [复习词数, 2×复习词数]。
  const reviewWords = clamp(Math.round(practice.reviewWordsPerRound), 4, 6);
  const reviewQuestions = clamp(
    Math.round(practice.reviewQuestionsPerRound),
    reviewWords,
    reviewWords * 2,
  );
  const reviewQuestionOptions = Array.from(
    { length: reviewWords * 2 - reviewWords + 1 },
    (_, index) => reviewWords + index,
  );

  function updatePractice(patch: Partial<PracticeSettings>) {
    actions.setPracticeSettings(patch);
  }

  /** 发音设置必须整体回写（rate / voiceUri / autoPlay）。 */
  function updateTts(patch: Partial<TtsSettings>) {
    actions.setPracticeSettings({ tts: { ...practice.tts, ...patch } });
  }

  function handleReviewWordsChange(next: number) {
    const words = clamp(Math.round(next), 4, 6);
    actions.setPracticeSettings({
      reviewWordsPerRound: words,
      reviewQuestionsPerRound: clamp(
        Math.round(practice.reviewQuestionsPerRound),
        words,
        words * 2,
      ),
    });
  }

  // 复习题量越界时自动拉回合法区间（改复习词数后立刻生效）。
  useEffect(() => {
    if (
      practice.reviewWordsPerRound === reviewWords &&
      practice.reviewQuestionsPerRound === reviewQuestions
    ) {
      return;
    }
    actions.setPracticeSettings({
      reviewWordsPerRound: reviewWords,
      reviewQuestionsPerRound: reviewQuestions,
    });
  }, [
    actions,
    practice.reviewWordsPerRound,
    practice.reviewQuestionsPerRound,
    reviewWords,
    reviewQuestions,
  ]);

  // 导入备份 / 删除等操作会替换 providers；编辑目标不存在时收起表单。
  useEffect(() => {
    setEditor((current) => {
      if (current && current.mode === 'edit' && !data.providers.some((item) => item.id === current.id)) {
        return null;
      }
      return current;
    });
  }, [data.providers]);

  function openCreate() {
    if (atLimit) {
      actions.toast(`最多保存 ${MAX_PROVIDERS} 份配置`, 'info');
      return;
    }
    setEditor({ mode: 'create' });
    setImportError('');
  }

  function openEdit(id: string) {
    if (!data.providers.some((item) => item.id === id)) return;
    setEditor({ mode: 'edit', id });
    setImportError('');
  }

  function handleSave(draft: ProviderDraft): { ok: boolean; message?: string } {
    if (editor && editor.mode === 'edit') {
      actions.updateProvider(editor.id, draft);
      actions.toast('模型配置已更新', 'success');
      setEditor(null);
      return { ok: true };
    }
    const result = actions.addProvider(draft);
    if (result.ok) setEditor(null);
    return result;
  }

  function confirmDelete() {
    const target = deleteTarget;
    if (!target) return;
    actions.deleteProvider(target.id);
    setDeleteTarget(null);
    setEditor((current) =>
      current && current.mode === 'edit' && current.id === target.id ? null : current,
    );
  }

  function handleExportBackup() {
    downloadJson(
      `deepword-backup-${new Date().toISOString().slice(0, 10)}.json`,
      exportBackup(data, { includeApiKey: includeKey }),
    );
    actions.toast(
      includeKey ? '完整备份已导出（包含 API Key，请妥善保管）' : '备份已导出（不含 API Key）',
      'success',
    );
  }

  async function handleImportFile(file: File | undefined) {
    if (!file) return;
    setImportError('');
    try {
      const text = await file.text();
      const next = parseBackup(text);
      setPendingImport(next);
      setDialog('import');
    } catch (error) {
      setImportError(error instanceof Error ? error.message : '备份文件解析失败');
    }
  }

  function confirmDialog() {
    if (dialog === 'import' && pendingImport) {
      actions.importBackup(pendingImport);
      setPendingImport(null);
      setEditor(null);
    } else if (dialog === 'clear-progress') {
      actions.clearProgress();
    } else if (dialog === 'reset-all') {
      actions.resetAll();
    }
    setDialog(null);
  }

  function setTheme(theme: ThemeMode) {
    actions.setTheme(theme);
  }

  return (
    <div className="settings">
      <header className="view-head">
        <div>
          <div className="view-head__eyebrow">
            <span className="mono-label">SETTINGS</span>
            <span
              className={`badge ${aiReady ? 'badge--sage badge--dot' : 'badge--gold badge--dot'}`}
            >
              {aiStatusLabel}
            </span>
          </div>
          <h1 className="view-title">设置</h1>
          <p className="view-sub">
            保存多份大模型配置，仅「当前使用」的一份参与出题与判分。所有数据与密钥只保存在这台设备的浏览器里。
          </p>
        </div>
      </header>

      <div className="settings-grid">
        <div className="settings-col">
          <section className="card settings-card">
            <header className="settings-card__head">
              <span className="settings-card__index">壹</span>
              <div>
                <h2 className="settings-card__title">模型连接</h2>
                <p className="settings-card__sub">
                  支持 OpenAI 兼容接口与 Anthropic；同一时间只有一份配置生效。
                </p>
              </div>
              {!editor && (
                <div className="settings-card__head-actions">
                  <span className="mono-label">
                    {data.providers.length} / {MAX_PROVIDERS}
                  </span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={openCreate}
                    disabled={atLimit}
                  >
                    <IconPlus size={14} /> 新增配置
                  </button>
                </div>
              )}
            </header>

            <div className="settings-card__body">
              {editor ? (
                <ProviderEditor
                  key={editor.mode === 'edit' ? editor.id : 'create'}
                  mode={editor.mode}
                  initial={editingProfile}
                  onCancel={() => setEditor(null)}
                  onSave={handleSave}
                />
              ) : (
                <>
                  <ProviderList
                    providers={data.providers}
                    activeProviderId={data.activeProviderId}
                    atLimit={atLimit}
                    onAdd={openCreate}
                    onEdit={openEdit}
                    onDelete={(profile) => setDeleteTarget(profile)}
                    onSetActive={(id) => actions.setActiveProvider(id)}
                  />

                  {atLimit && (
                    <p className="hint">
                      已达到 {MAX_PROVIDERS} 份配置上限；删除一份后才能继续新增。
                    </p>
                  )}

                  <p className="settings-note">
                    <strong>安全提示：</strong>API Key 仅保存在本机 localStorage 中，
                    请求经本地代理转发，不记录、不上传。删除配置会一并删除其中保存的 Key。
                  </p>
                </>
              )}
            </div>
          </section>

          <section className="card settings-card settings-practice">
            <header className="settings-card__head">
              <span className="settings-card__index">贰</span>
              <div>
                <h2 className="settings-card__title">练习设置</h2>
                <p className="settings-card__sub">
                  一轮怎么练、答对后多久翻页、发音怎么读。改完立即生效。
                </p>
              </div>
            </header>
            <div className="settings-card__body">
              <div className="field-row">
                <div className="field">
                  <label className="label" htmlFor="practice-new-words">
                    每轮新词数
                  </label>
                  <select
                    id="practice-new-words"
                    className="select"
                    value={practice.newWordsPerRound}
                    onChange={(event) =>
                      updatePractice({ newWordsPerRound: Number(event.target.value) })
                    }
                  >
                    {NEW_WORDS_OPTIONS.map((count) => (
                      <option key={count} value={count}>
                        {count} 个
                      </option>
                    ))}
                  </select>
                  <span className="hint">一轮认几个新词；贪多不如吃透，默认 1 个。</span>
                </div>

                <div className="field">
                  <label className="label" htmlFor="practice-questions-per-word">
                    每词题量
                  </label>
                  <select
                    id="practice-questions-per-word"
                    className="select"
                    value={practice.questionsPerNewWord}
                    onChange={(event) =>
                      updatePractice({ questionsPerNewWord: Number(event.target.value) })
                    }
                  >
                    {QUESTIONS_PER_WORD_OPTIONS.map((count) => (
                      <option key={count} value={count}>
                        {count} 题
                      </option>
                    ))}
                  </select>
                  <span className="hint">一个新词出几道题，覆盖英译中、中译英、拼写等。</span>
                </div>
              </div>

              <div className="field-row">
                <div className="field">
                  <label className="label" htmlFor="practice-review-words">
                    每轮复习词数
                  </label>
                  <select
                    id="practice-review-words"
                    className="select"
                    value={reviewWords}
                    onChange={(event) => handleReviewWordsChange(Number(event.target.value))}
                  >
                    {REVIEW_WORDS_OPTIONS.map((count) => (
                      <option key={count} value={count}>
                        {count} 个
                      </option>
                    ))}
                  </select>
                  <span className="hint">新词之后，按薄弱度挑几个旧词回炉。</span>
                </div>

                <div className="field">
                  <label className="label" htmlFor="practice-review-questions">
                    每轮复习题量
                  </label>
                  <select
                    id="practice-review-questions"
                    className="select"
                    value={reviewQuestions}
                    onChange={(event) =>
                      updatePractice({ reviewQuestionsPerRound: Number(event.target.value) })
                    }
                  >
                    {reviewQuestionOptions.map((count) => (
                      <option key={count} value={count}>
                        {count} 题
                      </option>
                    ))}
                  </select>
                  <span className="hint">
                    随复习词数联动，范围 {reviewWords}～{reviewWords * 2} 题，保证每个复习词至少被问一次。
                  </span>
                </div>
              </div>

              <div className="field">
                <span className="label">答对后自动跳转</span>
                <div className="segmented" role="group" aria-label="答对后自动跳转">
                  {AUTO_ADVANCE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={cx(
                        'segmented__option',
                        practice.feedbackAutoAdvanceMs === option.value &&
                          'segmented__option--active',
                      )}
                      aria-pressed={practice.feedbackAutoAdvanceMs === option.value}
                      onClick={() => updatePractice({ feedbackAutoAdvanceMs: option.value })}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <span className="hint">答对后停留几秒自动翻到下一题；答错一定等你看完讲解。</span>
              </div>

              <div className="settings-practice__row">
                <div className="settings-practice__text">
                  <span className="label">自动讲解</span>
                  <span className="hint">答错时自动生成错因、记忆点与改进建议。</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={practice.autoExplain}
                  aria-label="自动讲解"
                  className="switch"
                  onClick={() => updatePractice({ autoExplain: !practice.autoExplain })}
                />
              </div>

              <hr className="divider" />

              <div className="field settings-range">
                <span className="label">
                  <span>发音语速</span>
                  <span className="settings-range__value">{practice.tts.rate.toFixed(1)}×</span>
                </span>
                <input
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.1}
                  value={practice.tts.rate}
                  onChange={(event) => updateTts({ rate: Number(event.target.value) })}
                  aria-label="发音语速"
                />
                <span className="hint">0.5 最慢、2 最快；听音题与自动朗读都用这个语速。</span>
              </div>

              <div className="field">
                <label className="label" htmlFor="practice-tts-voice">
                  英文语音
                </label>
                <select
                  id="practice-tts-voice"
                  className="select"
                  value={practice.tts.voiceUri}
                  disabled={voices.length === 0}
                  onChange={(event) => updateTts({ voiceUri: event.target.value })}
                >
                  <option value="">自动选择（系统默认英文语音）</option>
                  {voices.map((voice) => (
                    <option key={voice.voiceUri} value={voice.voiceUri}>
                      {voice.name} · {voice.lang}
                    </option>
                  ))}
                </select>
                <span className="hint">
                  {voices.length > 0
                    ? `检测到 ${voices.length} 个英文语音，可挑一个顺耳的。`
                    : '当前浏览器没有可用的英文语音，听音题会暂时不出现；换用 Chrome / Edge / Safari 可恢复。'}
                </span>
              </div>

              <div className="settings-practice__row">
                <div className="settings-practice__text">
                  <span className="label">自动朗读</span>
                  <span className="hint">进入练习时自动朗读单词与例句。</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={practice.tts.autoPlay}
                  aria-label="自动朗读发音"
                  className="switch"
                  onClick={() => updateTts({ autoPlay: !practice.tts.autoPlay })}
                />
              </div>
            </div>
          </section>

          <section className="card settings-card">
            <header className="settings-card__head">
              <span className="settings-card__index">叁</span>
              <div>
                <h2 className="settings-card__title">数据管理</h2>
                <p className="settings-card__sub">数据只存在这个浏览器里。请定期导出备份。</p>
              </div>
            </header>

            <div className="settings-card__body">
              <div className="settings-data-row">
                <div>
                  <p className="settings-data-row__title">本机存储</p>
                  <p className="settings-data-row__desc">
                    已占用 {usage.human} · {data.words.length} 个词条 · {data.attempts.length} 条作答记录
                    · {data.providers.length} 份配置
                  </p>
                </div>
                <span className="badge badge--outline">localStorage</span>
              </div>

              <div className="settings-data-actions">
                <button type="button" className="btn btn--ghost" onClick={handleExportBackup}>
                  <IconDownload size={15} /> 导出完整备份
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => importInputRef.current?.click()}
                >
                  <IconUpload size={15} /> 导入备份
                </button>
                <input
                  ref={importInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="settings-file"
                  onChange={(event) => {
                    void handleImportFile(event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
              </div>

              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  checked={includeKey}
                  onChange={(event) => setIncludeKey(event.target.checked)}
                />
                <span>
                  导出时包含 API Key
                  <span className="hint">（默认不含，避免备份文件泄露密钥）</span>
                </span>
              </label>

              {importError && <p className="field-error">导入失败：{importError}</p>}

              <hr className="divider" />

              <div className="settings-danger">
                <div>
                  <p className="settings-data-row__title">清空学习进度</p>
                  <p className="settings-data-row__desc">保留词库、模型配置与主题，重置所有卡片、错题与统计。</p>
                  <button
                    type="button"
                    className="btn btn--danger btn--sm"
                    onClick={() => setDialog('clear-progress')}
                  >
                    清空进度
                  </button>
                </div>
                <div>
                  <p className="settings-data-row__title">恢复示例词库</p>
                  <p className="settings-data-row__desc">删除自建词条与全部进度，回到内置词库初始状态。</p>
                  <button
                    type="button"
                    className="btn btn--danger btn--sm"
                    onClick={() => setDialog('reset-all')}
                  >
                    恢复初始数据
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>

        <div className="settings-col settings-col--side">
          <section className="card settings-card">
            <header className="settings-card__head">
              <span className="settings-card__index">肆</span>
              <div>
                <h2 className="settings-card__title">外观</h2>
                <p className="settings-card__sub">纸与墨，各有适合的时刻。</p>
              </div>
            </header>
            <div className="settings-card__body">
              <div className="theme-choice" role="group" aria-label="主题">
                {(
                  [
                    { value: 'light' as const, title: '昼读', desc: '宣纸暖白，适合白天' },
                    { value: 'dark' as const, title: '夜读', desc: '墨色深底，适合夜晚' },
                  ]
                ).map((choice) => (
                  <button
                    key={choice.value}
                    type="button"
                    aria-pressed={data.theme === choice.value}
                    className={
                      data.theme === choice.value
                        ? 'theme-choice__option theme-choice__option--active'
                        : 'theme-choice__option'
                    }
                    onClick={() => setTheme(choice.value)}
                  >
                    <span className={`theme-choice__swatch is-${choice.value}`} aria-hidden="true">
                      <span />
                      <span />
                    </span>
                    <span className="theme-choice__text">
                      <strong>{choice.title}</strong>
                      <span>{choice.desc}</span>
                    </span>
                    {data.theme === choice.value && <IconCheck size={15} />}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="card settings-card settings-about">
            <header className="settings-card__head">
              <span className="settings-card__index">伍</span>
              <div>
                <h2 className="settings-card__title">关于词渊</h2>
                <p className="settings-card__sub">以错题为师，以温故为舟。</p>
              </div>
            </header>
            <div className="settings-card__body">
              <div className="settings-about__brand">
                <span className="seal">渊</span>
                <div>
                  <strong>词渊 DeepWord</strong>
                  <span>v{APP_VERSION} · 本地优先的 LLM 背单词工作台</span>
                </div>
              </div>
              <ul className="settings-about__list">
                <li>
                  <span>出题引擎</span>
                  <strong>OpenAI 兼容 / Anthropic</strong>
                </li>
                <li>
                  <span>当前配置</span>
                  <strong className="settings-about__summary">
                    {activeProfile
                      ? `${providerName(activeProfile, activeIndex)} · ${providerSummaryText(activeProfile)}`
                      : '尚未配置'}
                  </strong>
                </li>
                <li>
                  <span>思考开关</span>
                  <strong className="settings-about__summary">
                    {activeProfile
                      ? `${thinkingModeLabel(activeProfile.thinkingMode)}${
                          activeProfile.thinkingMode === 'off' ? '（部分模型可能不生效）' : ''
                        }`
                      : '—'}
                  </strong>
                </li>
                <li>
                  <span>提示词版本</span>
                  <strong className="settings-about__mono">{PROMPT_VERSION}</strong>
                </li>
                <li>
                  <span>记忆算法</span>
                  <strong>SM-2 变体 · 四档自评</strong>
                </li>
                <li>
                  <span>数据存储</span>
                  <strong>浏览器 localStorage</strong>
                </li>
              </ul>
              <p className="settings-about__privacy">
                你的单词、错题、模型配置与 API Key 都只保存在本机。应用没有后台服务器，不会收集任何学习数据。
                清除浏览器数据或使用无痕模式会导致记录丢失。
              </p>
              <div className="settings-about__foot">
                <IconSparkle size={14} />
                <span>错词不是失败，是下一次记住的线索。</span>
              </div>
            </div>
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除这份配置？"
        message={
          <>
            将删除「{deleteTarget?.name.trim() || '未命名配置'}」及其保存的 API Key。
            {deleteTarget && deleteTarget.id === data.activeProviderId
              ? '这是当前使用的配置，删除后会切换到列表中的第一份；没有其它配置时，AI 功能会退回本地题库。'
              : '此操作不可撤销。'}
          </>
        }
        confirmLabel="删除配置"
        danger
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
      <ConfirmDialog
        open={dialog === 'import'}
        title="导入备份？"
        message={
          <>
            将用备份中的词库、学习记录与模型配置<strong>覆盖当前数据</strong>；备份中缺失的 API Key
            会按 Base URL 继承本机已有 Key。导入后无法撤销，建议先导出一份当前备份。
          </>
        }
        confirmLabel="覆盖并导入"
        danger
        onClose={() => setDialog(null)}
        onConfirm={confirmDialog}
      />
      <ConfirmDialog
        open={dialog === 'clear-progress'}
        title="清空学习进度？"
        message="所有卡片排程、错题档案、作答历史与统计都会被清空，词库、模型配置与主题保留。此操作不可撤销。"
        confirmLabel="清空进度"
        danger
        onClose={() => setDialog(null)}
        onConfirm={confirmDialog}
      />
      <ConfirmDialog
        open={dialog === 'reset-all'}
        title="恢复初始数据？"
        message="将删除所有自建词条与学习进度，并载入内置示例词库。模型配置与主题会保留。此操作不可撤销。"
        confirmLabel="恢复初始数据"
        danger
        onClose={() => setDialog(null)}
        onConfirm={confirmDialog}
      />
    </div>
  );
}
