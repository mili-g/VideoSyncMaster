import { useCallback, useEffect, useMemo, useState } from 'react';
import PageFrame from '../layout/PageFrame';
import type { AsrService } from '../utils/asrService';
import type { TtsService } from '../utils/modelProfiles';
import type { AsrDiagnosticsResponse, ModelStatusResponse, PythonEnvCheckResponse, StatusDetail } from '../types/backend';

interface DiagnosticsPageProps {
    selectedAsrService: AsrService;
    selectedTtsService: TtsService;
    missingDeps: string[];
    onStatusChange?: (status: string) => void;
    onRepairEnv?: () => void;
    onOpenModels?: () => void;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error';
type ReadinessState = 'loading' | 'ready' | 'blocked';

const localAsrStatusKeyMap: Partial<Record<AsrService, string>> = {
    'faster-whisper': 'faster_whisper_runtime',
    funasr: 'funasr_standard',
    qwen: 'qwen_asr_17b',
    'vibevoice-asr': 'vibevoice_asr_standard',
};

function toWorkflowTone(ready: boolean): 'success' | 'warning' {
    return ready ? 'success' : 'warning';
}

function resolveReadinessState(loading: boolean, ready: boolean): ReadinessState {
    if (loading) {
        return 'loading';
    }
    return ready ? 'ready' : 'blocked';
}

function getReadinessLabel(state: ReadinessState): string {
    if (state === 'loading') {
        return '检查中';
    }
    return state === 'ready' ? '就绪' : '阻塞';
}

function getReadinessActionLabel(state: ReadinessState): string {
    if (state === 'loading') {
        return '检测中';
    }
    return toWorkflowTone(state === 'ready') === 'success' ? '可执行' : '需处理';
}

function getSelectedAsrReadiness(
    asrService: AsrService,
    modelStatus: ModelStatusResponse | null,
    diagnostics: AsrDiagnosticsResponse | null
) {
    if (diagnostics?.success === false) {
        return {
            ready: false,
            detail: diagnostics.error || 'ASR 诊断失败。'
        };
    }

    const check = diagnostics?.checks?.find((item) => item.service === asrService);
    if (check) {
        return {
            ready: check.ok,
            detail: check.detail
        };
    }

    const key = localAsrStatusKeyMap[asrService];
    if (!key) {
        return {
            ready: true,
            detail: '在线通道状态以实际请求结果为准。'
        };
    }

    if (modelStatus?.success === false) {
        return {
            ready: false,
            detail: modelStatus.error || '模型状态检查失败。'
        };
    }

    if (!modelStatus && !diagnostics) {
        return {
            ready: false,
            detail: '诊断信息加载中。'
        };
    }

    const installed = Boolean(modelStatus?.status?.[key]);
    const detail = modelStatus?.status_details?.[key]?.detail || '未获取到通道状态。';
    return { ready: installed, detail };
}

export default function DiagnosticsPage({
    selectedAsrService,
    selectedTtsService,
    missingDeps,
    onStatusChange,
    onRepairEnv,
    onOpenModels
}: DiagnosticsPageProps) {
    const [pythonEnv, setPythonEnv] = useState<PythonEnvCheckResponse | null>(null);
    const [modelStatus, setModelStatus] = useState<ModelStatusResponse | null>(null);
    const [asrDiagnostics, setAsrDiagnostics] = useState<AsrDiagnosticsResponse | null>(null);
    const [loadState, setLoadState] = useState<LoadState>('idle');
    const [asrDiagnosticsLoadState, setAsrDiagnosticsLoadState] = useState<LoadState>('idle');
    const [errorMessage, setErrorMessage] = useState('');

    const refresh = useCallback(async () => {
        setLoadState('loading');
        setErrorMessage('');

        try {
            const [pythonResult, modelResult] = await Promise.all([
                window.api.checkPythonEnv(),
                window.api.checkModelStatus()
            ]);

            setPythonEnv(pythonResult);
            setModelStatus(modelResult);
            setLoadState('ready');

            const issues = [
                pythonResult.success === false ? 1 : 0,
                (pythonResult.missing || []).length,
                modelResult.success === false ? 1 : 0
            ].reduce((sum, value) => sum + value, 0);

            onStatusChange?.(issues > 0 ? `诊断完成，发现 ${issues} 个待处理项。` : '诊断完成，工作流已具备执行条件。');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setLoadState('error');
            setErrorMessage(message);
            onStatusChange?.(`环境诊断失败: ${message}`);
        }
    }, [onStatusChange]);

    const runAsrDiagnostics = useCallback(async () => {
        setAsrDiagnosticsLoadState('loading');
        try {
            const result = await window.api.runAsrDiagnostics();
            setAsrDiagnostics(result);
            setAsrDiagnosticsLoadState('ready');
            const issues = [
                (result.failed_checks || []).length,
                (result.failed_probes || []).length
            ].reduce((sum, value) => sum + value, 0);
            onStatusChange?.(issues > 0 ? `ASR 诊断完成，发现 ${issues} 个问题。` : 'ASR 诊断完成，所有通道通过。');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setAsrDiagnosticsLoadState('error');
            setAsrDiagnostics({ success: false, error: message });
            onStatusChange?.(`ASR 诊断失败: ${message}`);
        }
    }, [onStatusChange]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const selectedAsrReadiness = useMemo(
        () => getSelectedAsrReadiness(selectedAsrService, modelStatus, asrDiagnostics),
        [asrDiagnostics, modelStatus, selectedAsrService]
    );

    const selectedTtsReady = useMemo(() => {
        if (modelStatus?.success === false) {
            return {
                ready: false,
                detail: modelStatus.error || '模型状态检查失败。'
            };
        }

        if (!modelStatus) {
            return {
                ready: false,
                detail: '模型状态加载中。'
            };
        }

        const status = modelStatus?.status || {};
        const statusDetails = modelStatus?.status_details || {};
        if (selectedTtsService === 'indextts') {
            return {
                ready: Boolean(status.index_tts),
                detail: status.index_tts
                    ? (statusDetails.index_tts?.detail || 'Index-TTS 已就绪。')
                    : (statusDetails.index_tts?.detail || 'Index-TTS 未安装或不完整。')
            };
        }

        const hasTokenizer = Boolean(status.qwen_tokenizer);
        const hasBase = Boolean(status.qwen_17b_base || status.qwen_06b_base);
        return {
            ready: hasTokenizer && hasBase,
            detail: hasTokenizer && hasBase
                ? 'Qwen3-TTS 已就绪。'
                : [
                    !hasTokenizer ? (statusDetails.qwen_tokenizer?.detail || 'Qwen3-TTS tokenizer 未就绪。') : '',
                    !hasBase ? (
                        statusDetails.qwen_17b_base?.detail
                        || statusDetails.qwen_06b_base?.detail
                        || 'Qwen3-TTS 基础模型未就绪。'
                    ) : ''
                ].filter(Boolean).join(' ')
        };
    }, [modelStatus, selectedTtsService]);

    const workflowReady = pythonEnv?.success !== false
        && (pythonEnv?.missing || []).length === 0
        && selectedAsrReadiness.ready
        && selectedTtsReady.ready;
    const isChecking = loadState === 'loading' || loadState === 'idle';
    const isAsrDiagnosticsChecking = asrDiagnosticsLoadState === 'loading';
    const workflowState = resolveReadinessState(
        isChecking && (!pythonEnv || !modelStatus),
        workflowReady
    );

    const failedChecks = asrDiagnostics?.checks?.filter((item) => !item.ok) || [];
    const failedProbes = asrDiagnostics?.probes?.filter((item) => !item.ok) || [];
    const statusDetails = modelStatus?.status_details || {};
    const highlightedModelIssues = Object.entries(statusDetails)
        .filter(([, detail]) => detail.state !== 'ready')
        .slice(0, 6) as Array<[string, StatusDetail]>;
    const modelStatusFailure = modelStatus?.success === false ? (modelStatus.error || '模型状态检查失败。') : '';
    const asrDiagnosticsFailure = asrDiagnostics?.success === false ? (asrDiagnostics.error || 'ASR 诊断执行失败。') : '';

    const readinessCards = [
        {
            key: 'python',
            title: 'Python 运行环境',
            state: resolveReadinessState(
                isChecking && !pythonEnv,
                pythonEnv?.success !== false && (pythonEnv?.missing || []).length === 0
            ),
            detail: !pythonEnv
                ? '正在检查 Python 运行环境和 requirements 依赖。'
                : pythonEnv.success === false
                    ? (pythonEnv.error || 'Python 运行环境不可用。')
                    : (pythonEnv.missing || []).length > 0
                        ? `缺少依赖: ${(pythonEnv.missing || []).join(', ')}`
                        : 'requirements.txt 对应依赖已满足。'
        },
        {
            key: 'asr',
            title: 'ASR 通道',
            state: resolveReadinessState(
                isChecking && !asrDiagnostics && !modelStatus,
                selectedAsrReadiness.ready
            ),
            detail: isChecking && !asrDiagnostics && !modelStatus
                ? '正在检查 ASR 通道。'
                : selectedAsrReadiness.detail
        },
        {
            key: 'tts',
            title: 'TTS 通道',
            state: resolveReadinessState(
                isChecking && !modelStatus,
                selectedTtsReady.ready
            ),
            detail: !modelStatus && isChecking
                ? '正在检查 TTS 通道。'
                : selectedTtsReady.detail
        }
    ];

    return (
        <div className="view-page-shell">
            <PageFrame
                eyebrow="Diagnostics"
                title="环境诊断"
                description="展示运行环境、模型状态与工作流就绪度。"
                headerMode="hidden"
            >
                <div className="config-page">
                    <div className="config-page__hero">
                        <div>
                            <span className="config-page__eyebrow">Readiness</span>
                            <h1>环境诊断</h1>
                            <p>用于快速确认可用状态与阻塞项。</p>
                        </div>
                        <div className="config-page__hero-meta">
                            <div className="status-kpi">
                                <span className="status-kpi__label">工作流</span>
                                <strong>{getReadinessLabel(workflowState)}</strong>
                            </div>
                            <div className="status-kpi">
                                <span className="status-kpi__label">失败检查</span>
                                <strong>{isAsrDiagnosticsChecking ? '检查中' : asrDiagnostics ? failedChecks.length : '未运行'}</strong>
                            </div>
                            <div className="status-kpi">
                                <span className="status-kpi__label">失败探测</span>
                                <strong>{isAsrDiagnosticsChecking ? '检查中' : asrDiagnostics ? failedProbes.length : '未运行'}</strong>
                            </div>
                        </div>
                    </div>

                    <div className="model-toolbar">
                        <div className="model-root-card">
                            <span className="model-root-card__label">引擎组合</span>
                            <strong title={`ASR: ${selectedAsrService} / TTS: ${selectedTtsService}`}>
                                ASR: {selectedAsrService} / TTS: {selectedTtsService}
                            </strong>
                            <small>主流程将按此组合执行。</small>
                        </div>
                        <div className="output-dir-toolbar__actions">
                            <button type="button" className="secondary-button" onClick={() => void refresh()} disabled={loadState === 'loading'}>
                                刷新诊断
                            </button>
                            <button type="button" className="secondary-button" onClick={() => void runAsrDiagnostics()} disabled={isAsrDiagnosticsChecking}>
                                {isAsrDiagnosticsChecking ? 'ASR 诊断中' : '运行 ASR 诊断'}
                            </button>
                            <button type="button" className="secondary-button secondary-button--primary" onClick={onOpenModels}>
                                打开模型中心
                            </button>
                            <button type="button" className="secondary-button" onClick={onRepairEnv}>
                                修复 Python 依赖
                            </button>
                        </div>
                    </div>

                    {loadState === 'error' && (
                        <section className="config-section">
                            <div className="config-section__head">
                                <div>
                                    <h3>诊断失败</h3>
                                    <p>{errorMessage}</p>
                                </div>
                            </div>
                        </section>
                    )}

                    <section className="config-section">
                        <div className="config-section__head">
                            <div>
                                <h3>工作流就绪度</h3>
                                <p>评估主流程执行条件。</p>
                            </div>
                        </div>
                        <div className="model-grid">
                            {readinessCards.map((item) => (
                                <article
                                    key={item.key}
                                    className={`model-card${item.state === 'ready' ? ' model-card--ready' : item.state === 'blocked' ? ' model-card--missing' : ''}`}
                                >
                                    <div className="model-card__header">
                                        <div>
                                            <h4>{item.title}</h4>
                                            <p>{item.detail}</p>
                                        </div>
                                        <span className={`model-status-pill${item.state === 'ready' ? ' model-status-pill--ready' : ''}`}>
                                            {getReadinessLabel(item.state)}
                                        </span>
                                    </div>
                                    <div className="model-meta-list">
                                        <div className="model-meta-item">
                                            <span>状态</span>
                                            <strong>{getReadinessActionLabel(item.state)}</strong>
                                        </div>
                                    </div>
                                </article>
                            ))}
                        </div>
                    </section>

                    <section className="config-section">
                        <div className="config-section__head">
                            <div>
                                <h3>ASR 通道诊断</h3>
                                <p>验证识别通道的执行能力与模型状态。</p>
                            </div>
                        </div>
                        {!asrDiagnostics && (
                            <article className="model-card">
                                <div className="model-card__header">
                                    <div>
                                        <h4>尚未运行 ASR 诊断</h4>
                                        <p>按需手动触发识别通道诊断。</p>
                                    </div>
                                    <span className="model-status-pill">idle</span>
                                </div>
                            </article>
                        )}
                        <div className="model-grid">
                            {(asrDiagnostics?.checks || []).map((check) => {
                                const probe = asrDiagnostics?.probes?.find((item) => item.service === check.service);
                                return (
                                    <article key={check.service} className={`model-card${check.ok ? ' model-card--ready' : ' model-card--missing'}`}>
                                        <div className="model-card__header">
                                            <div>
                                                <h4>{check.service}</h4>
                                                <p>{check.detail}</p>
                                            </div>
                                            <span className={`model-status-pill${check.ok ? ' model-status-pill--ready' : ''}`}>
                                                {check.ok ? '通过' : '失败'}
                                            </span>
                                        </div>
                                        <div className="model-meta-list">
                                            <div className="model-meta-item">
                                                <span>执行结果</span>
                                                <strong>{probe ? (probe.ok ? `通过 / ${probe.segment_count} 段` : '失败') : '未执行'}</strong>
                                            </div>
                                            {probe && !probe.ok && (
                                                <div className="model-meta-item model-meta-item--path">
                                                    <span>失败原因</span>
                                                    <strong title={probe.detail}>{probe.detail}</strong>
                                                </div>
                                            )}
                                        </div>
                                    </article>
                                );
                            })}
                        </div>
                    </section>

                    <section className="config-section">
                        <div className="config-section__head">
                            <div>
                                <h3>模型与运行时问题</h3>
                                <p>仅展示需要处理的模型与运行时问题。</p>
                            </div>
                        </div>
                        <div className="model-grid">
                            {highlightedModelIssues.length === 0 ? (
                                <article className={`model-card${modelStatusFailure || asrDiagnosticsFailure ? ' model-card--missing' : ' model-card--ready'}`}>
                                    <div className="model-card__header">
                                        <div>
                                            <h4>{modelStatusFailure || asrDiagnosticsFailure ? '检查链路异常' : '未发现额外阻塞'}</h4>
                                            <p>
                                                {modelStatusFailure
                                                    || asrDiagnosticsFailure
                                                    || '关键模型与运行时均已就绪。'}
                                            </p>
                                        </div>
                                        <span className={`model-status-pill${modelStatusFailure || asrDiagnosticsFailure ? '' : ' model-status-pill--ready'}`}>
                                            {modelStatusFailure || asrDiagnosticsFailure ? '异常' : '正常'}
                                        </span>
                                    </div>
                                </article>
                            ) : highlightedModelIssues.map(([key, detail]) => (
                                <article key={key} className="model-card model-card--missing">
                                    <div className="model-card__header">
                                        <div>
                                            <h4>{key}</h4>
                                            <p>{detail.detail}</p>
                                        </div>
                                        <span className="model-status-pill">{detail.state}</span>
                                    </div>
                                </article>
                            ))}
                        </div>
                    </section>

                    {loadState === 'ready' && (missingDeps.length > 0 || failedChecks.length > 0 || failedProbes.length > 0) && (
                        <section className="config-section">
                            <div className="config-section__head">
                                <div>
                                <h3>阻塞项</h3>
                                <p>以下问题会直接影响主流程执行。</p>
                                </div>
                            </div>
                            <div className="model-grid">
                                {missingDeps.length > 0 && (
                                    <article className="model-card model-card--missing">
                                        <div className="model-card__header">
                                            <div>
                                                <h4>Python 依赖缺失</h4>
                                                <p>{missingDeps.join(', ')}</p>
                                            </div>
                                        </div>
                                    </article>
                                )}
                                {failedChecks.map((item) => (
                                    <article key={`check-${item.service}`} className="model-card model-card--missing">
                                        <div className="model-card__header">
                                            <div>
                                                <h4>{item.service}</h4>
                                                <p>{item.detail}</p>
                                            </div>
                                        </div>
                                    </article>
                                ))}
                            </div>
                        </section>
                    )}
                </div>
            </PageFrame>
        </div>
    );
}
