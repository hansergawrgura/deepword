import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/AppState';
import type { AppData, LLMSettings, ProviderKind, ThemeMode } from '../types';
import {
  PROVIDER_PRESETS,
  exportBackup,
  getStorageUsage,
  parseBackup,
} from '../lib/storage';
import { testLLMConnection, PROMPT_VERSION } from '../lib/llm';
import type { LLMConnectionResult } from '../lib/llm';
import { formatLatency, isLocalEndpoint } from '../lib/utils';
import { ConfirmDialog } from './ui/ConfirmDialog';
import {
  IconCheck,
  IconDownload,
  IconEyeToggle,
  IconRefresh,
  IconSparkle,
  IconUpload,
} from './ui/icons';
import './Settings.css';

const OPENAI_PRESETS = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { label: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
];

const ANTHROPIC_MODELS = ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1'];
const OPENAI_MODELS = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'deepseek-chat', 'qwen2.5:7b'];

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'done'; result: LLMConnectionResult };

type DialogKind = 'import' | 'clear-progress' | 'reset-all' | null;

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
  const [draft, setDraft] = useState<LLMSettings>(data.settings);
  const [showKey, setShowKey] = useState(false);
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [pendingImport, setPendingImport] = useState<AppData | null>(null);
  const [importError, setImportError] = useState('');
  const [includeKey, setIncludeKey] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  // 导入备份 / 恢复初始数据会替换全局 settings，草稿需同步，避免旧值被误保存覆盖。
  useEffect(() => {
    setDraft(data.settings);
    setTest({ status: 'idle' });
  }, [data.settings]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(data.settings), [draft, data.settings]);
  const usage = useMemo(() => getStorageUsage(), [data.updatedAt]);
  const modelOptions = draft.provider === 'anthropic' ? ANTHROPIC_MODELS : OPENAI_MODELS;
  const providerPreset = PROVIDER_PRESETS[draft.provider];
  const configured = Boolean(data.settings.baseUrl.trim() && data.settings.model.trim());
  const needsKey =
    !data.settings.apiKey.trim() &&
    (data.settings.provider === 'anthropic' || !isLocalEndpoint(data.settings.baseUrl));
  const aiReady = configured && !needsKey;
  const aiStatusLabel = !configured ? 'AI 出题未配置' : needsKey ? '待填写 API Key' : 'AI 出题已就绪';

  const patch = (next: Partial<LLMSettings>) => {
    setDraft((current) => ({ ...current, ...next }));
    if (test.status !== 'idle') setTest({ status: 'idle' });
  };

  const changeProvider = (provider: ProviderKind) => {
    setDraft((current) => {
      if (current.provider === provider) return current;
      const prevPreset = PROVIDER_PRESETS[current.provider];
      const nextPreset = PROVIDER_PRESETS[provider];
      const customBase = current.baseUrl !== prevPreset.baseUrl;
      const customModel = current.model !== prevPreset.model;
      return {
        ...current,
        provider,
        baseUrl: customBase ? current.baseUrl : nextPreset.baseUrl,
        model: customModel ? current.model : nextPreset.model,
      };
    });
    setTest({ status: 'idle' });
  };

  const save = () => {
    actions.updateSettings(draft);
    actions.toast('模型设置已保存到本机', 'success');
    setTest({ status: 'idle' });
  };

  const runTest = async () => {
    if (!draft.baseUrl.trim() || !draft.model.trim()) {
      setTest({
        status: 'done',
        result: { ok: false, latencyMs: 0, message: '请先填写接口地址与模型名称。' },
      });
      return;
    }
    setTest({ status: 'testing' });
    const started = performance.now();
    const result = await testLLMConnection(draft);
    setTest({
      status: 'done',
      result: {
        ...result,
        latencyMs: result.latencyMs || Math.round(performance.now() - started),
      },
    });
  };

  const handleExportBackup = () => {
    downloadJson(
      `deepword-backup-${new Date().toISOString().slice(0, 10)}.json`,
      exportBackup(data, { includeApiKey: includeKey }),
    );
    actions.toast(includeKey ? '完整备份已导出（包含 API Key，请妥善保管）' : '备份已导出（不含 API Key）', 'success');
  };

  const handleImportFile = async (file: File | undefined) => {
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
  };

  const confirmDialog = () => {
    if (dialog === 'import' && pendingImport) {
      actions.importBackup(pendingImport);
      setPendingImport(null);
    } else if (dialog === 'clear-progress') {
      actions.clearProgress();
    } else if (dialog === 'reset-all') {
      actions.resetAll();
    }
    setDialog(null);
  };

  const setTheme = (theme: ThemeMode) => {
    actions.setTheme(theme);
  };

  return (
    <div className="settings">
      <header className="view-head">
        <div>
          <div className="view-head__eyebrow">
            <span className="mono-label">SETTINGS</span>
            <span className={`badge ${aiReady ? 'badge--sage badge--dot' : 'badge--gold badge--dot'}`}>
              {aiStatusLabel}
            </span>
          </div>
          <h1 className="view-title">设置</h1>
          <p className="view-sub">
            接入你自己的大模型，让错题被重新命题。所有数据与密钥只保存在这台设备的浏览器里。
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
                  支持 OpenAI 兼容接口与 Anthropic。请求从浏览器直接发往你填写的地址。
                </p>
              </div>
            </header>

            <div className="settings-card__body">
              <div className="field">
                <span className="label">接口协议</span>
                <div className="segmented settings-provider" role="group" aria-label="接口协议">
                  {(Object.keys(PROVIDER_PRESETS) as ProviderKind[]).map((provider) => (
                    <button
                      key={provider}
                      type="button"
                      className={
                        draft.provider === provider
                          ? 'segmented__option segmented__option--active'
                          : 'segmented__option'
                      }
                      aria-pressed={draft.provider === provider}
                      onClick={() => changeProvider(provider)}
                    >
                      {PROVIDER_PRESETS[provider].label}
                    </button>
                  ))}
                </div>
                <p className="hint">{providerPreset.hint}</p>
              </div>

              {draft.provider === 'openai' && (
                <div className="field">
                  <span className="label">常用服务</span>
                  <div className="settings-presets">
                    {OPENAI_PRESETS.map((preset) => {
                      const active =
                        draft.baseUrl === preset.baseUrl && draft.model === preset.model;
                      return (
                        <button
                          key={preset.label}
                          type="button"
                          className={active ? 'chip chip--active' : 'chip'}
                          onClick={() =>
                            patch({ baseUrl: preset.baseUrl, model: preset.model })
                          }
                        >
                          {preset.label}
                          {active && <IconCheck size={12} />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <label className="field">
                <span className="label">
                  接口地址 Base URL
                  <span className="mono-label">API ENDPOINT</span>
                </span>
                <input
                  className="input"
                  value={draft.baseUrl}
                  onChange={(event) => patch({ baseUrl: event.target.value })}
                  placeholder="https://api.openai.com/v1"
                  spellCheck={false}
                  autoComplete="off"
                />
                <span className="hint">
                  {draft.provider === 'anthropic'
                    ? '填写 Claude 接口地址，程序会自动拼接 /messages；浏览器直连会自动携带所需请求头。'
                    : '填到版本号即可（如 /v1），程序会自动拼接 /chat/completions。DeepSeek、Moonshot、硅基流动、Ollama 等兼容服务均可使用。'}
                </span>
              </label>

              <div className="field-row">
                <label className="field">
                  <span className="label">模型</span>
                  <input
                    className="input"
                    list="deepword-model-options"
                    value={draft.model}
                    onChange={(event) => patch({ model: event.target.value })}
                    placeholder={providerPreset.model}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <datalist id="deepword-model-options">
                    {modelOptions.map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                </label>

                <label className="field">
                  <span className="label">
                    API Key
                    <span className="hint settings-inline-hint">
                      {draft.provider === 'openai' ? '本地模型可留空' : '必填'}
                    </span>
                  </span>
                  <span className="settings-key">
                    <input
                      className="input"
                      type={showKey ? 'text' : 'password'}
                      value={draft.apiKey}
                      onChange={(event) => patch({ apiKey: event.target.value })}
                      placeholder="sk-..."
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="icon-btn settings-key__toggle"
                      onClick={() => setShowKey((current) => !current)}
                      aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                    >
                      <IconEyeToggle size={16} />
                    </button>
                  </span>
                </label>
              </div>

              <div className="settings-tuning">
                <label className="field settings-range">
                  <span className="label">
                    温度 Temperature
                    <span className="settings-range__value">{draft.temperature.toFixed(1)}</span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1.5}
                    step={0.1}
                    value={draft.temperature}
                    onChange={(event) => patch({ temperature: Number(event.target.value) })}
                  />
                  <span className="hint">越低越稳定，出题更守规矩；越高越有变化，但更易跑题。</span>
                </label>

                <label className="field settings-max-tokens">
                  <span className="label">最大输出 Tokens</span>
                  <input
                    className="input"
                    type="number"
                    min={256}
                    max={16000}
                    step={100}
                    value={draft.maxTokens}
                    onChange={(event) =>
                      patch({ maxTokens: Math.max(64, Number(event.target.value) || 64) })
                    }
                  />
                  <span className="hint">一次生成 6~8 道练习，建议 2000~4000。</span>
                </label>
              </div>

              {test.status === 'done' && (
                <div
                  className={
                    test.result.ok ? 'callout settings-test-result' : 'callout callout--error settings-test-result'
                  }
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

              <div className="settings-actions">
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
                <button type="button" className="btn btn--primary" onClick={save} disabled={!dirty}>
                  {dirty ? '保存设置' : '设置已保存'}
                </button>
              </div>

              <p className="settings-note">
                <strong>安全提示：</strong>API Key 仅保存在本机 localStorage 中，不会上传到任何第三方。
                浏览器直连第三方接口可能受 CORS 限制；若连接失败，请确认服务支持浏览器跨域请求，或使用本地代理。
              </p>
            </div>
          </section>

          <section className="card settings-card">
            <header className="settings-card__head">
              <span className="settings-card__index">贰</span>
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
                  <p className="settings-data-row__desc">保留词库与设置，重置所有卡片、错题与统计。</p>
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
              <span className="settings-card__index">叁</span>
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
              <span className="settings-card__index">肆</span>
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
                  <span>v1.0.0 · 本地优先的 LLM 背单词工作台</span>
                </div>
              </div>
              <ul className="settings-about__list">
                <li>
                  <span>出题引擎</span>
                  <strong>OpenAI 兼容 / Anthropic</strong>
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
                你的单词、错题与 API Key 都只保存在本机。应用没有后台服务器，不会收集任何学习数据。
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
        open={dialog === 'import'}
        title="导入备份？"
        message={
          <>
            将用备份中的词库与学习记录<strong>覆盖当前全部数据</strong>，当前 API Key 会被保留。
            导入后无法撤销，建议先导出一份当前备份。
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
        message="所有卡片排程、错题档案、作答历史与统计都会被清空，词库与模型设置保留。此操作不可撤销。"
        confirmLabel="清空进度"
        danger
        onClose={() => setDialog(null)}
        onConfirm={confirmDialog}
      />
      <ConfirmDialog
        open={dialog === 'reset-all'}
        title="恢复初始数据？"
        message="将删除所有自建词条与学习进度，并载入内置示例词库。模型设置与主题会保留。此操作不可撤销。"
        confirmLabel="恢复初始数据"
        danger
        onClose={() => setDialog(null)}
        onConfirm={confirmDialog}
      />
    </div>
  );
}
