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
} from '../../types';
import { checkBaseUrl, VENDOR_OPTIONS, VENDOR_PRESETS, vendorLabel } from '../../lib/providerModel';
import { testLLMConnection } from '../../lib/llm';
import type { LLMConnectionResult } from '../../lib/llm';
import { cx, formatLatency, isLocalEndpoint } from '../../lib/utils';
import { IconClose, IconEyeToggle, IconRefresh } from '../ui/icons';
import ModelListDialog from './ModelListDialog';
import {
  PROTOCOL_OPTIONS,
  draftFromProfile,
  draftToLLMSettings,
  emptyProviderDraft,
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

  const preset = VENDOR_PRESETS[draft.vendor];
  const protocolHint = PROTOCOL_OPTIONS.find((option) => option.value === draft.protocol)?.hint ?? '';
  const baseUrlCheck = checkBaseUrl(draft.baseUrl);
  const baseUrlError =
    (touched.baseUrl || submitted) && !baseUrlCheck.ok ? (baseUrlCheck.message ?? 'Base URL 不合法。') : '';
  const modelError =
    (touched.model || submitted) && !draft.defaultModel.trim() ? '请填写默认 model，例如 deepseek-chat。' : '';
  const keyHint = isLocalEndpoint(draft.baseUrl)
    ? '本地端点可留空'
    : draft.protocol === 'anthropic'
      ? 'Anthropic 必填'
      : '远端接口通常必填';

  const thinkingOptions: ReadonlyArray<{ value: ThinkingMode; label: string }> = [
    { value: 'off', label: '尽量关闭' },
    { value: 'provider-default', label: '交给服务商默认' },
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

  function fillPreset() {
    if (!preset.baseUrl) return;
    setDraft((current) => ({
      ...current,
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      defaultModel: preset.model || current.defaultModel,
    }));
    setTouched((current) => ({ ...current, baseUrl: true }));
    resetFeedback();
  }

  async function runTest() {
    const check = checkBaseUrl(draft.baseUrl);
    if (!check.ok || !draft.defaultModel.trim()) {
      setTest({
        status: 'done',
        result: {
          ok: false,
          latencyMs: 0,
          message: check.ok ? '请先填写默认 model，再测试连接。' : (check.message ?? '请先补全 Base URL。'),
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
    const check = checkBaseUrl(draft.baseUrl);
    if (!check.ok) {
      setFormError(check.message ?? '请填写合法的 Base URL。');
      return;
    }
    if (!draft.defaultModel.trim()) {
      setFormError('请填写默认 model。');
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
    if (!result.ok) setFormError(result.message ?? '保存失败，请稍后再试。');
  }

  return (
    <section className="provider-editor" aria-labelledby="provider-editor-title">
      <header className="provider-editor__head">
        <div>
          <p className="mono-label">{mode === 'create' ? 'NEW / 新增配置' : 'EDIT / 编辑配置'}</p>
          <h3 className="provider-editor__title" id="provider-editor-title">
            {mode === 'create'
              ? '新增模型配置'
              : `编辑「${initial?.name.trim() || '未命名配置'}」`}
          </h3>
          <p className="hint">
            保存后可随时切换「当前使用」；出题、判分与讲解都使用当前使用的那一份。
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={onCancel} aria-label="关闭编辑">
          <IconClose size={18} />
        </button>
      </header>

      <form className="provider-editor__form" onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label className="label" htmlFor="provider-name">
            <span>名称</span>
            <span className="hint settings-inline-hint">用于区分多份配置，可留空</span>
          </label>
          <input
            id="provider-name"
            className="input"
            value={draft.name}
            maxLength={40}
            onChange={(event) => update({ name: event.target.value })}
            placeholder="例如：DeepSeek 主力 / 本地 Ollama"
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div className="provider-editor__grid">
          <div className="field">
            <span className="label">接口协议</span>
            <div className="segmented settings-provider" role="group" aria-label="接口协议">
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
                  {option.label}
                </button>
              ))}
            </div>
            <span className="hint">{protocolHint}</span>
          </div>

          <div className="field">
            <label className="label" htmlFor="provider-vendor">
              厂商
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
            <span className="hint">只影响「关闭思考」参数与预设，不改变接口协议。</span>
          </div>
        </div>

        <div className="field">
          <span className="label">
            <span>
              Base URL <span className="mono-label">API ENDPOINT</span>
            </span>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={fillPreset}
              disabled={!preset.baseUrl}
              title={preset.hint}
            >
              填入预设
            </button>
          </span>
          <input
            id="provider-base-url"
            className="input"
            value={draft.baseUrl}
            onChange={(event) => update({ baseUrl: event.target.value })}
            onBlur={() => setTouched((current) => ({ ...current, baseUrl: true }))}
            placeholder={preset.baseUrl || 'https://api.example.com/v1'}
            spellCheck={false}
            autoComplete="off"
            aria-label="Base URL"
            aria-invalid={Boolean(baseUrlError)}
          />
          <span className="hint">
            {draft.protocol === 'anthropic'
              ? '填厂商给的前缀即可（官方 …/v1、火山方舟 …/api/coding），程序会自动补齐 /v1/messages。'
              : '填到版本号即可（如 /v1），程序会自动拼接 /chat/completions。'}
          </span>
          {baseUrlError && <span className="field-error">{baseUrlError}</span>}
        </div>

        <div className="field-row">
          <div className="field">
            <label className="label" htmlFor="provider-default-model">
              <span>默认 model</span>
              <span className="hint settings-inline-hint">可自由输入</span>
            </label>
            <input
              id="provider-default-model"
              className="input"
              list="provider-model-suggestions"
              value={draft.defaultModel}
              onChange={(event) => update({ defaultModel: event.target.value })}
              onBlur={() => setTouched((current) => ({ ...current, model: true }))}
              placeholder={preset.model || '例如 deepseek-chat'}
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
              <span>API Key</span>
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
                aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                aria-pressed={showKey}
              >
                <IconEyeToggle size={16} />
              </button>
            </span>
            <span className="hint">仅保存在本机；请求经本地代理转发，不会上传。</span>
          </div>
        </div>

        <div className="provider-editor__models">
          <div>
            <p className="provider-editor__models-title">模型白名单</p>
            <p className="hint">
              已保留 {draft.models.length} 个模型；用于搜索与切换。默认 model 不受白名单限制。
            </p>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setModelsOpen(true)}
          >
            <IconRefresh size={14} /> 拉取模型列表
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
              <span>温度 Temperature</span>
              <span className="settings-range__value">{draft.temperature.toFixed(1)}</span>
            </span>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.1}
              value={draft.temperature}
              onChange={(event) => update({ temperature: Number(event.target.value) })}
              aria-label="温度 Temperature"
            />
            <span className="hint">越低越稳定，出题更守规矩；越高越有变化，但更易跑题。</span>
          </div>

          <div className="field settings-max-tokens">
            <label className="label" htmlFor="provider-max-tokens">
              最大输出 Tokens
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
            <span className="hint">一次生成 6~8 道练习，建议 2000~4000。</span>
          </div>
        </div>

        <div className="field provider-editor__thinking">
          <span className="label">思考开关</span>
          <div className="segmented" role="group" aria-label="思考开关">
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
          <span className="hint">
            选「尽量关闭」会按厂商注入关闭思考的参数（不同厂商参数不同）。部分模型不支持关闭思考，
            即使这样设置也可能仍会思考，请以实际返回为准。
          </span>
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
                <span className="spinner" /> 正在连接…
              </>
            ) : (
              <>
                <IconRefresh size={15} /> 测试连接
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
                  {test.result.ok ? '连接成功' : '连接失败'}
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
            取消
          </button>
          <button type="submit" className="btn btn--primary">
            {mode === 'create' ? '保存配置' : '保存修改'}
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
