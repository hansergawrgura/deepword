/**
 * 设置页：多 provider 管理 + 数据管理 + 外观 + 关于。
 *
 * Provider 的增删改 / 切换当前使用只通过 useApp().actions 写入；
 * 列表与编辑表单的展示逻辑拆到 features/settings/providers/ 下。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/app/store';
import type {
  AppData,
  PracticeSettings,
  ProviderDraft,
  ProviderProfile,
  ThemeMode,
  TtsSettings,
} from '@/domain/types';
import { DEFAULT_PRACTICE_SETTINGS, MAX_PROVIDERS } from '@/domain/types';
import { exportBackup, getStorageUsage, importBackup } from '@/infra/storage/storage';
import {
  findActiveProvider,
  providerName,
  providerSummaryText,
  resolveActiveLLMSettings,
} from '@/infra/llm/providerModel';
import { useEnglishVoices } from '@/infra/tts';
import { FEEDBACK_PROMPT_VERSION } from '@/infra/llm';
import { downloadBackupName } from '@/app/identity';
import { APP_VERSION } from '@/app/version';
import { useLocale, useT } from '@/i18n';
import type { Locale } from '@/i18n';
import { clamp, cx, isLocalEndpoint } from '@/domain/utils';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { IconCheck, IconDownload, IconPlus, IconSparkle, IconUpload } from '@/ui/icons';
import ProviderEditor from './providers/ProviderEditor';
import ProviderList from './providers/ProviderList';
import { thinkingModeLabel } from './providers/draft';
import './Settings.css';

type EditorState = { mode: 'create' } | { mode: 'edit'; id: string };
type DialogKind = 'import' | 'clear-progress' | 'reset-all' | null;

/** Per-word question count options (4–8). */
const QUESTIONS_PER_WORD_OPTIONS = [4, 5, 6, 7, 8];
/** Review words per round options (4–6). */
const REVIEW_WORDS_OPTIONS = [4, 5, 6];
/** New words per round options (1–10). */
const NEW_WORDS_OPTIONS = Array.from({ length: 10 }, (_, index) => index + 1);
/** Auto-advance delay in ms; 0 = manual. */
const AUTO_ADVANCE_OPTIONS = [
  { value: 3_000, key: 'settings.autoAdvance3s' as const },
  { value: 5_000, key: 'settings.autoAdvance5s' as const },
  { value: 0, key: 'common.manual' as const },
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
  const t = useT();
  const locale = useLocale();
  const { data, actions } = useApp();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProviderProfile | null>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [pendingImport, setPendingImport] = useState<AppData | null>(null);
  const [importError, setImportError] = useState('');
  const [includeKey, setIncludeKey] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  // {t('settings.ttsVoice')}列表：浏览器可能在首次加载后才拿到 voices，Hook 内部监听 voiceschanged。
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
    ? t('settings.aiNone')
    : !configured
      ? t('settings.aiIncomplete')
      : needsKey
        ? t('settings.aiNeedKey')
        : t('settings.aiReady');
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
      actions.toast(t('settings.providerLimit', { max: MAX_PROVIDERS }), 'info');
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
      actions.toast(t('settings.providerUpdated'), 'success');
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
      downloadBackupName(new Date().toISOString().slice(0, 10)),
      exportBackup(data, { includeApiKey: includeKey }),
    );
    actions.toast(
      includeKey ? t('settings.toastExportedKey') : t('settings.toastExported'),
      'success',
    );
  }

  async function handleImportFile(file: File | undefined) {
    if (!file) return;
    setImportError('');
    try {
      const text = await file.text();
      const next = importBackup(text);
      setPendingImport(next);
      setDialog('import');
    } catch (error) {
      setImportError(error instanceof Error ? error.message : t('settings.parseBackupFailed'));
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
          <h1 className="view-title">{t('settings.title')}</h1>
          <p className="view-sub">
            {t('settings.subtitle')}
          </p>
        </div>
      </header>

      <div className="settings-grid">
        <div className="settings-col">
          <section className="card settings-card">
            <header className="settings-card__head">
              <span className="settings-card__index">{t('settings.section1')}</span>
              <div>
                <h2 className="settings-card__title">{t('settings.modelsTitle')}</h2>
                <p className="settings-card__sub">
                  {t('settings.modelsSub')}
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
                    <IconPlus size={14} /> {t('settings.addProvider')}
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
                      {t('settings.providerLimit', { max: MAX_PROVIDERS })}
                    </p>
                  )}

                  <p className="settings-note">
                    <strong>{t('settings.securityNote')}</strong>
                  </p>
                </>
              )}
            </div>
          </section>

          <section className="card settings-card settings-practice">
            <header className="settings-card__head">
              <span className="settings-card__index">{t('settings.section2')}</span>
              <div>
                <h2 className="settings-card__title">{t('settings.practiceTitle')}</h2>
                <p className="settings-card__sub">
                  {t('settings.practiceSub')}
                </p>
              </div>
            </header>
            <div className="settings-card__body">
              <div className="field-row">
                <div className="field">
                  <label className="label" htmlFor="practice-new-words">
                    {t('settings.newWordsPerRound')}
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
                        {t('settings.optionCount', { count })}
                      </option>
                    ))}
                  </select>
                  <span className="hint">{t('settings.hintNewWordsPerRound')}</span>
                </div>

                <div className="field">
                  <label className="label" htmlFor="practice-questions-per-word">
                    {t('settings.questionsPerWord')}
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
                        {t('settings.optionQuestions', { count })}
                      </option>
                    ))}
                  </select>
                  <span className="hint">{t('settings.hintQuestionsPerWord')}</span>
                </div>
              </div>

              <div className="field-row">
                <div className="field">
                  <label className="label" htmlFor="practice-review-words">
                    {t('settings.reviewWords')}
                  </label>
                  <select
                    id="practice-review-words"
                    className="select"
                    value={reviewWords}
                    onChange={(event) => handleReviewWordsChange(Number(event.target.value))}
                  >
                    {REVIEW_WORDS_OPTIONS.map((count) => (
                      <option key={count} value={count}>
                        {t('settings.optionCount', { count })}
                      </option>
                    ))}
                  </select>
                  <span className="hint">{t('settings.hintReviewWords')}</span>
                </div>

                <div className="field">
                  <label className="label" htmlFor="practice-review-questions">
                    {t('settings.reviewQuestions')}
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
                        {t('settings.optionQuestions', { count })}
                      </option>
                    ))}
                  </select>
                  <span className="hint">
                    {t('settings.hintReviewQuestions', { min: reviewWords, max: reviewWords * 2 })}
                  </span>
                </div>
              </div>

              <div className="field">
                <span className="label">{t('settings.autoAdvance')}</span>
                <div className="segmented" role="group" aria-label={t('settings.autoAdvance')}>
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
                      {t(option.key)}
                    </button>
                  ))}
                </div>
                <span className="hint">{t('settings.hintAutoAdvance')}</span>
              </div>

              <div className="settings-practice__row">
                <div className="settings-practice__text">
                  <span className="label">{t('settings.autoExplain')}</span>
                  <span className="hint">{t('settings.hintAutoExplain')}</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={practice.autoExplain}
                  aria-label={t('settings.autoExplain')}
                  className="switch"
                  onClick={() => updatePractice({ autoExplain: !practice.autoExplain })}
                />
              </div>

              <hr className="divider" />

              <div className="field settings-range">
                <span className="label">
                  <span>{t('settings.ttsRate')}</span>
                  <span className="settings-range__value">{practice.tts.rate.toFixed(1)}×</span>
                </span>
                <input
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.1}
                  value={practice.tts.rate}
                  onChange={(event) => updateTts({ rate: Number(event.target.value) })}
                  aria-label={t('settings.ttsRate')}
                />
                <span className="hint">{t('settings.hintTtsRate')}</span>
              </div>

              <div className="field">
                <label className="label" htmlFor="practice-tts-voice">
                  {t('settings.ttsVoice')}
                </label>
                <select
                  id="practice-tts-voice"
                  className="select"
                  value={practice.tts.voiceUri}
                  disabled={voices.length === 0}
                  onChange={(event) => updateTts({ voiceUri: event.target.value })}
                >
                  <option value="">{t('settings.ttsVoiceAuto')}</option>
                  {voices.map((voice) => (
                    <option key={voice.voiceUri} value={voice.voiceUri}>
                      {voice.name} · {voice.lang}
                    </option>
                  ))}
                </select>
                <span className="hint">
                  {voices.length > 0
                    ? t('settings.hintTtsVoices', { count: voices.length })
                    : t('settings.hintTtsNone')}
                </span>
              </div>

              <div className="settings-practice__row">
                <div className="settings-practice__text">
                  <span className="label">{t('settings.autoPlay')}</span>
                  <span className="hint">{t('settings.hintTtsAutoPlay')}</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={practice.tts.autoPlay}
                  aria-label={t('settings.autoPlay')}
                  className="switch"
                  onClick={() => updateTts({ autoPlay: !practice.tts.autoPlay })}
                />
              </div>
            </div>
          </section>

          <section className="card settings-card">
            <header className="settings-card__head">
              <span className="settings-card__index">{t('settings.section3')}</span>
              <div>
                <h2 className="settings-card__title">{t('settings.dataTitle')}</h2>
                <p className="settings-card__sub">{t('settings.dataSub')}</p>
              </div>
            </header>

            <div className="settings-card__body">
              <div className="settings-data-row">
                <div>
                  <p className="settings-data-row__title">{t('settings.localStorageTitle')}</p>
                  <p className="settings-data-row__desc">
                    {t('settings.localStorageDesc', {
                    usage: usage.human,
                    words: data.words.length,
                    attempts: data.attempts.length,
                    providers: data.providers.length,
                  })}
                  </p>
                </div>
                <span className="badge badge--outline">{t('settings.storageValue')}</span>
              </div>

              <div className="settings-data-actions">
                <button type="button" className="btn btn--ghost" onClick={handleExportBackup}>
                  <IconDownload size={15} /> {t('settings.exportBackup')}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => importInputRef.current?.click()}
                >
                  <IconUpload size={15} /> {t('settings.importBackup')}
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
                <span>{t('settings.includeApiKey')}</span>
              </label>

              {importError && <p className="field-error">{t('settings.importFailed')}{importError}</p>}

              <hr className="divider" />

              <div className="settings-danger">
                <div>
                  <p className="settings-data-row__title">{t('settings.clearProgressTitle')}</p>
                  <p className="settings-data-row__desc">{t('settings.clearProgressDesc')}</p>
                  <button
                    type="button"
                    className="btn btn--danger btn--sm"
                    onClick={() => setDialog('clear-progress')}
                  >
                    {t('settings.clearProgress')}
                  </button>
                </div>
                <div>
                  <p className="settings-data-row__title">{t('settings.resetSampleTitle')}</p>
                  <p className="settings-data-row__desc">{t('settings.resetSampleDesc')}</p>
                  <button
                    type="button"
                    className="btn btn--danger btn--sm"
                    onClick={() => setDialog('reset-all')}
                  >
                    {t('settings.resetSample')}
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>

        <div className="settings-col settings-col--side">
          <section className="card settings-card">
            <header className="settings-card__head">
              <span className="settings-card__index">{t('settings.section4')}</span>
              <div>
                <h2 className="settings-card__title">{t('theme.appearanceTitle')}</h2>
                <p className="settings-card__sub">{t('theme.appearanceSub')}</p>
              </div>
            </header>
            <div className="settings-card__body">
              <div className="theme-choice" role="group" aria-label={t('theme.themeGroup')}>
                {(
                  [
                    { value: 'light' as const, titleKey: 'theme.day' as const, descKey: 'theme.dayDesc' as const },
                    { value: 'dark' as const, titleKey: 'theme.night' as const, descKey: 'theme.nightDesc' as const },
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
                      <strong>{t(choice.titleKey)}</strong>
                      <span>{t(choice.descKey)}</span>
                    </span>
                    {data.theme === choice.value && <IconCheck size={15} />}
                  </button>
                ))}
              </div>
            </div>
          </section>


          <section className="card settings-card">
            <header className="settings-card__head">
              <span className="settings-card__index">{t('settings.sectionLang')}</span>
              <div>
                <h2 className="settings-card__title">{t('settings.languageTitle')}</h2>
                <p className="settings-card__sub">{t('settings.languageSub')}</p>
              </div>
            </header>
            <div className="settings-card__body">
              <div className="segmented" role="group" aria-label={t('settings.languageTitle')}>
                {(['en', 'zh-CN'] as Locale[]).map((loc) => (
                  <button
                    key={loc}
                    type="button"
                    className={cx(
                      'segmented__option',
                      locale === loc && 'segmented__option--active',
                    )}
                    aria-pressed={locale === loc}
                    onClick={() => actions.setLocale(loc)}
                  >
                    {loc === 'en' ? t('common.languageEn') : t('common.languageZh')}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="card settings-card settings-about">
            <header className="settings-card__head">
              <span className="settings-card__index">{t('settings.section5')}</span>
              <div>
                <h2 className="settings-card__title">{t('settings.aboutTitle', { name: t('brand.name') })}</h2>
                <p className="settings-card__sub">{t('brand.motto')}</p>
              </div>
            </header>
            <div className="settings-card__body">
              <div className="settings-about__brand">
                <span className="seal">{t('brand.seal')}</span>
                <div>
                  <strong>{t('brand.name')}</strong>
                  <span>{t('brand.versionLine', { version: APP_VERSION })}</span>
                  <span className="hint">{t('settings.aboutAlias')}</span>
                </div>
              </div>
              <ul className="settings-about__list">
                <li>
                  <span>{t('settings.engine')}</span>
                  <strong>{t('settings.engineValue')}</strong>
                </li>
                <li>
                  <span>{t('settings.activeProfile')}</span>
                  <strong className="settings-about__summary">
                    {activeProfile
                      ? `${providerName(activeProfile, activeIndex, locale)} · ${providerSummaryText(activeProfile, locale)}`
                      : t('settings.notConfigured')}
                  </strong>
                </li>
                <li>
                  <span>{t('providers.thinking')}</span>
                  <strong className="settings-about__summary">
                    {activeProfile
                      ? `${thinkingModeLabel(activeProfile.thinkingMode, t)}${
                          activeProfile.thinkingMode === 'off' ? t('settings.thinkingSwitchNote') : ''
                        }`
                      : '—'}
                  </strong>
                </li>
                <li>
                  <span>{t('settings.promptVersion')}</span>
                  <strong className="settings-about__mono">{FEEDBACK_PROMPT_VERSION}</strong>
                </li>
                <li>
                  <span>{t('settings.memoryAlgorithm')}</span>
                  
                </li>
                <li>
                  <span>{t('settings.storageLabel')}</span>
                  <strong>{t('settings.storageValue')}</strong>
                </li>
              </ul>
              <p className="settings-about__privacy">
                {t('settings.privacy')}
              </p>
              <div className="settings-about__foot">
                <IconSparkle size={14} />
                <span>{t('brand.quoteMistakes')}</span>
              </div>
            </div>
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('settings.confirmDeleteProvider')}
        message={
          <>
            {t('settings.confirmDeleteProviderBody', {
              name: deleteTarget?.name.trim() || t('settings.unnamedProfile'),
            })}
            {deleteTarget && deleteTarget.id === data.activeProviderId ? (
              <span> {t('settings.deleteActiveProviderExtra')}</span>
            ) : null}
          </>
        }
        confirmLabel={t('settings.deleteProvider')}
        danger
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
      <ConfirmDialog
        open={dialog === 'import'}
        title={t('settings.confirmImport')}
        message={
          <>
            {t('settings.confirmImportBody')} {t('settings.importBackupKeyHint')}
          </>
        }
        confirmLabel={t('settings.confirmImportButton')}
        danger
        onClose={() => setDialog(null)}
        onConfirm={confirmDialog}
      />
      <ConfirmDialog
        open={dialog === 'clear-progress'}
        title={t('settings.confirmClearProgress')}
        message={t('settings.confirmClearProgressMsg')}
        confirmLabel="{t('settings.clearProgress')}"
        danger
        onClose={() => setDialog(null)}
        onConfirm={confirmDialog}
      />
      <ConfirmDialog
        open={dialog === 'reset-all'}
        title="{t('settings.resetSample')}？"
        message={t('settings.confirmResetMsg')}
        confirmLabel="{t('settings.resetSample')}"
        danger
        onClose={() => setDialog(null)}
        onConfirm={confirmDialog}
      />
    </div>
  );
}
