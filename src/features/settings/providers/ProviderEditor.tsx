/**
 * Provider 编辑表单：名称、协议、厂商、Base URL、API Key、默认 model、
 * 白名单、温度、最大 tokens、思考开关，以及测试连接。
 *
 * 表单只维护本地草稿；保存 / 切换 / 删除由父组件调用 useApp().actions。
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  ProviderDraft,
  ProviderProfile,
  ThinkingMode,
  Vendor,
} from '@/domain/types';
import { checkBaseUrl, VENDOR_OPTIONS, vendorLabel } from '@/infra/llm/providerModel';
import { testLLMConnection } from '@/infra/llm';
import type { LLMConnectionResult } from '@/infra/llm';
import { cx, formatLatency, isLocalEndpoint } from '@/domain/utils';
import { IconClose, IconEyeToggle, IconRefresh } from '@/ui/icons';
import ModelListDialog from './ModelListDialog';
import { useLocale, useT } from '@/i18n';
import {
  PROTOCOL_OPTIONS,
  draftFromProfile,
  draftToLLMSettings,
  emptyProviderDraft,
  protocolLabel,
} from './draft';

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'done'; result: LLMConnectionResult };

export interface ProviderEditorProps {
  mode: 'create' | 'edit';
  initial: ProviderProfile | null;
  onCancel: () => void;
  /** 返回 addProvider 的结果；失败时表单保持打开并展示 message。 */
  onSave: (draft: ProviderDraft) => { ok: boolean; message?: string };
}

export default function ProviderEditor({
  mode,
  initial,
  onCancel,
  onSave,
}: ProviderEditorProps) {
  const t = useT();
  const locale = useLocale();
  const [draft, setDraft] = useState<ProviderDraft>(() =>
    initial ? draftFromProfile(initial) : emptyProviderDraft(),
  );
  const [showKey, setShowKey] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  const [submitted, setSubmitted] = useState(false);
  const [touched, setTouched] = useState<{ baseUrl: boolean; model: boolean }>({
    baseUrl: false,
    model: false,
  });
  const [formError, setFormError] = useState('');

  const mountedRef = useRef(true);
  const testSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      testSeqRef.current += 1;
    };
  }, []);

  const protocolHint =
    draft.protocol === 'anthropic' ? t('providers.anthropicHint') : t('providers.openaiHint');
  const baseUrlCheck = checkBaseUrl(draft.baseUrl, locale);
  const baseUrlError =
    (touched.baseUrl || submitted) && !baseUrlCheck.ok
      ? (baseUrlCheck.message ?? t('providers.baseUrlInvalid'))
      : '';
  const modelError =
    (touched.model || submitted) && !draft.defaultModel.trim()
      ? t('providers.defaultModelRequired')
      : '';
  const keyHint = isLocalEndpoint(draft.baseUrl)
    ? t('providers.apiKeyHintLocal')
    : draft.protocol === 'anthropic'
      ? t('providers.apiKeyHintAnthropic')
      : t('providers.apiKeyHintRemote');

  const thinkingOptions: ReadonlyArray<{ value: ThinkingMode; label: string }> = [
    { value: 'off', label: t('providers.thinkingOff') },
    { value: 'provider-default', label: t('providers.thinkingDefault') },
  ];

  function resetFeedback() {
    setFormError('');
    setTest({ status: 'idle' });
  }

  function update(patch: Partial<ProviderDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    resetFeedback();
  }

  function changeVendor(vendor: Vendor) {
    setDraft((current) => ({
      ...current,
      vendor,
      // 名称为空时用厂商名补一个可读的默认名称。
      name: current.name.trim() ? current.name : vendorLabel(vendor),
    }));
    resetFeedback();
  }

  async function runTest() {
    const check = checkBaseUrl(draft.baseUrl, locale);
    if (!check.ok || !draft.defaultModel.trim()) {
      setTest({
        status: 'done',
        result: {
          ok: false,
          latencyMs: 0,
          message: check.ok
            ? t('providers.testNeedModel')
            : (check.message ?? t('providers.baseUrlRequiredSubmit')),
        },
      });
      return;
    }
    setTest({ status: 'testing' });
    const seq = testSeqRef.current + 1;
    testSeqRef.current = seq;
    const startedAt = performance.now();
    const result = await testLLMConnection(draftToLLMSettings(draft));
    if (!mountedRef.current || seq !== testSeqRef.current) return;
    setTest({
      status: 'done',
      result: {
        ...result,
        latencyMs: result.latencyMs || Math.round(performance.now() - startedAt),
      },
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    const check = checkBaseUrl(draft.baseUrl, locale);
    if (!check.ok) {
      setFormError(check.message ?? t('providers.baseUrlRequiredSubmit'));
      return;
    }
    if (!draft.defaultModel.trim()) {
      setFormError(t('providers.defaultModelRequiredSubmit'));
      return;
    }
    const normalized: ProviderDraft = {
      ...draft,
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
      defaultModel: draft.defaultModel.trim(),
      models: Array.from(new Set(draft.models.map((model) => model.trim()).filter(Boolean))),
    };
    const result = onSave(normalized);
    if (!result.ok) setFormError(result.message ?? t('providers.saveFailedRetry'));
  }

  return (
    <section className="provider-editor" aria-labelledby="provider-editor-title">
      <header className="provider-editor__head">
        <div>
          <p className="mono-label">
            {mode === 'create' ? t('providers.editorBadgeNew') : t('providers.editorBadgeEdit')}
          </p>
          <h3 className="provider-editor__title" id="provider-editor-title">
            {mode === 'create'
              ? t('providers.createTitle')
              : t('providers.editTitle', {
                  name: initial?.name.trim() || t('settings.unnamedProfile'),
                })}
          </h3>
          <p className="hint">{t('providers.editorHint')}</p>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={onCancel}
          aria-label={t('providers.closeEditAria')}
        >
          <IconClose size={18} />
        </button>
      </header>

      <form className="provider-editor__form" onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label className="label" htmlFor="provider-name">
            <span>{t('providers.name')}</span>
            <span className="hint settings-inline-hint">{t('providers.nameInlineHint')}</span>
          </label>
          <input
            id="provider-name"
            className="input"
            value={draft.name}
            maxLength={40}
            onChange={(event) => update({ name: event.target.value })}
            placeholder={t('providers.namePlaceholder')}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div className="provider-editor__grid">
          <div className="field">
            <span className="label">{t('providers.protocol')}</span>
            <div
              className="segmented settings-provider"
              role="group"
              aria-label={t('providers.protocol')}
            >
              {PROTOCOL_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={cx(
                    'segmented__option',
                    draft.protocol === option.value && 'segmented__option--active',
                  )}
                  aria-pressed={draft.protocol === option.value}
                  onClick={() => update({ protocol: option.value })}
                >
                  {protocolLabel(option.value, t)}
                </button>
              ))}
            </div>
            <span className="hint">{protocolHint}</span>
          </div>

          <div className="field">
            <label className="label" htmlFor="provider-vendor">
              {t('providers.vendor')}
            </label>
            <select
              id="provider-vendor"
              className="select"
              value={draft.vendor}
              onChange={(event) => changeVendor(event.target.value as Vendor)}
            >
              {VENDOR_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="hint">{t('providers.vendorHint')}</span>
          </div>
        </div>

        <div className="field">
          <label className="label" htmlFor="provider-base-url">
            <span>
              {t('providers.baseUrl')}{' '}
              <span className="mono-label">{t('providers.apiEndpointLabel')}</span>
            </span>
          </label>
          <input
            id="provider-base-url"
            className="input"
            value={draft.baseUrl}
            onChange={(event) => update({ baseUrl: event.target.value })}
            onBlur={() => setTouched((current) => ({ ...current, baseUrl: true }))}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={Boolean(baseUrlError)}
          />
          <span className="hint">
            {draft.protocol === 'anthropic'
              ? t('providers.anthropicHint')
              : t('providers.baseUrlHintOpenai')}
          </span>
          {baseUrlError && <span className="field-error">{baseUrlError}</span>}
        </div>

        <div className="field-row">
          <div className="field">
            <label className="label" htmlFor="provider-default-model">
              <span>{t('providers.defaultModel')}</span>
              <span className="hint settings-inline-hint">{t('providers.defaultModelInlineHint')}</span>
            </label>
            <input
              id="provider-default-model"
              className="input"
              list="provider-model-suggestions"
              value={draft.defaultModel}
              onChange={(event) => update({ defaultModel: event.target.value })}
              onBlur={() => setTouched((current) => ({ ...current, model: true }))}
              placeholder={t('providers.defaultModelExample')}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={Boolean(modelError)}
            />
            <datalist id="provider-model-suggestions">
              {draft.models.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
            {modelError && <span className="field-error">{modelError}</span>}
          </div>

          <div className="field">
            <span className="label">
              <span>{t('providers.apiKey')}</span>
              <span className="hint settings-inline-hint">{keyHint}</span>
            </span>
            <span className="settings-key">
              <input
                className="input"
                type={showKey ? 'text' : 'password'}
                value={draft.apiKey}
                onChange={(event) => update({ apiKey: event.target.value })}
                placeholder="sk-..."
                spellCheck={false}
                autoComplete="off"
                aria-label="API Key"
              />
              <button
                type="button"
                className="icon-btn settings-key__toggle"
                onClick={() => setShowKey((current) => !current)}
                aria-label={showKey ? t('providers.hideApiKey') : t('providers.showApiKey')}
                aria-pressed={showKey}
              >
                <IconEyeToggle size={16} />
              </button>
            </span>
            <span className="hint">{t('providers.apiKeyStorageHint')}</span>
          </div>
        </div>

        <div className="provider-editor__models">
          <div>
            <p className="provider-editor__models-title">{t('providers.modelAllowlist')}</p>
            <p className="hint">{t('providers.allowlistHint', { count: draft.models.length })}</p>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setModelsOpen(true)}
          >
            <IconRefresh size={14} /> {t('providers.fetchModels')}
          </button>
        </div>

        {draft.models.length > 0 && (
          <div className="provider-editor__model-chips">
            {draft.models.slice(0, 6).map((model) => (
              <span key={model} className="chip chip--dashed provider-model-chip">
                {model}
              </span>
            ))}
            {draft.models.length > 6 && (
              <span className="chip chip--dashed provider-model-chip">
                +{draft.models.length - 6}
              </span>
            )}
          </div>
        )}

        <div className="settings-tuning">
          <div className="field settings-range">
            <span className="label">
              <span>{t('providers.temperatureLabel')}</span>
              <span className="settings-range__value">{draft.temperature.toFixed(1)}</span>
            </span>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.1}
              value={draft.temperature}
              onChange={(event) => update({ temperature: Number(event.target.value) })}
              aria-label={t('providers.temperatureAria')}
            />
            <span className="hint">{t('providers.temperatureHint')}</span>
          </div>

          <div className="field settings-max-tokens">
            <label className="label" htmlFor="provider-max-tokens">
              {t('providers.maxTokensLabel')}
            </label>
            <input
              id="provider-max-tokens"
              className="input"
              type="number"
              min={64}
              max={32000}
              step={100}
              value={draft.maxTokens}
              onChange={(event) =>
                update({ maxTokens: Math.max(64, Number(event.target.value) || 64) })
              }
            />
            <span className="hint">{t('providers.maxTokensHint')}</span>
          </div>
        </div>

        <div className="field provider-editor__thinking">
          <span className="label">{t('providers.thinking')}</span>
          <div className="segmented" role="group" aria-label={t('providers.thinking')}>
            {thinkingOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={cx(
                  'segmented__option',
                  draft.thinkingMode === option.value && 'segmented__option--active',
                )}
                aria-pressed={draft.thinkingMode === option.value}
                onClick={() => update({ thinkingMode: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className="hint">{t('providers.thinkingHint')}</span>
        </div>

        <div className="provider-editor__test">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void runTest()}
            disabled={test.status === 'testing'}
          >
            {test.status === 'testing' ? (
              <>
                <span className="spinner" /> {t('providers.connecting')}
              </>
            ) : (
              <>
                <IconRefresh size={15} /> {t('providers.testConnection')}
              </>
            )}
          </button>

          {test.status === 'done' && (
            <div
              className={cx(
                'callout',
                'settings-test-result',
                'provider-editor__test-result',
                !test.result.ok && 'callout--error',
              )}
            >
              <div>
                <span className="callout__title">
                  {test.result.ok ? t('providers.testOk') : t('providers.testFail')}
                  {test.result.ok && (
                    <span className="settings-test-latency">
                      {' '}
                      · {formatLatency(test.result.latencyMs)}
                      {test.result.model ? ` · ${test.result.model}` : ''}
                    </span>
                  )}
                </span>
                <p className="settings-test-message">{test.result.message}</p>
              </div>
            </div>
          )}
        </div>

        {formError && (
          <p className="field-error" role="alert">
            {formError}
          </p>
        )}

        <div className="settings-actions provider-editor__actions">
          <button type="button" className="btn btn--quiet" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn--primary">
            {mode === 'create' ? t('providers.save') : t('providers.saveEdit')}
          </button>
        </div>
      </form>

      <ModelListDialog
        open={modelsOpen}
        settings={draftToLLMSettings(draft)}
        selected={draft.models}
        onClose={() => setModelsOpen(false)}
        onConfirm={(models) => update({ models })}
      />
    </section>
  );
}
