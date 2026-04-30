import type { WorkflowOverviewModel, WorkflowStepState } from '../types/workflow';

const palette = {
    idle: { color: '#94a3b8', bg: 'rgba(148,163,184,0.12)' },
    ready: { color: '#38bdf8', bg: 'rgba(56,189,248,0.12)' },
    active: { color: '#a78bfa', bg: 'rgba(167,139,250,0.14)' },
    done: { color: '#34d399', bg: 'rgba(52,211,153,0.14)' },
    blocked: { color: '#f59e0b', bg: 'rgba(245,158,11,0.14)' },
    error: { color: '#f87171', bg: 'rgba(248,113,113,0.14)' }
};

export default function WorkflowOverview({
    model,
    compact = false
}: {
    model: WorkflowOverviewModel;
    compact?: boolean;
}) {
    const blockerTone = model.phase === 'attention' ? '#fca5a5' : 'rgba(255,255,255,0.72)';

    return (
        <div className="glass-panel" style={{ marginBottom: '12px', padding: compact ? '12px 16px' : '18px 20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div style={{ minWidth: 280 }}>
                    <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.76em', marginBottom: '4px' }}>工作流总览</div>
                    <div style={{ color: '#fff', fontSize: compact ? '1em' : '1.15em', fontWeight: 700 }}>{model.headline}</div>
                    {!compact && (
                        <div style={{ color: 'rgba(255,255,255,0.72)', marginTop: '8px', lineHeight: 1.6 }}>{model.recommendation}</div>
                    )}
                    {model.latestIssue && (
                        <div style={{
                            marginTop: compact ? '8px' : '12px',
                            padding: compact ? '8px 10px' : '10px 12px',
                            borderRadius: '10px',
                            background: 'rgba(248,113,113,0.1)',
                            border: '1px solid rgba(248,113,113,0.16)',
                            color: '#fecaca',
                            fontSize: '0.8em'
                        }}>
                            最近异常: {model.latestIssue.title}
                            {model.latestIssue.category ? ` · ${model.latestIssue.category}` : ''}
                            {model.latestIssue.traceId ? ` · Trace ${model.latestIssue.traceId}` : ''}
                        </div>
                    )}
                    {model.blockers.length > 0 && (
                        <div style={{ marginTop: compact ? '8px' : '12px', color: blockerTone, fontSize: '0.8em', lineHeight: 1.5 }}>
                            {model.blockers.map((blocker, index) => (
                                <div key={`${blocker}-${index}`}>阻塞项: {blocker}</div>
                            ))}
                        </div>
                    )}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: compact ? 'repeat(4, minmax(88px, 1fr))' : 'repeat(4, minmax(110px, 1fr))', gap: compact ? '8px' : '10px', flex: 1, minWidth: compact ? 300 : 360 }}>
                    <MetricCard label="原字幕" value={model.sourceCount} tone="#38bdf8" />
                    <MetricCard label="翻译字幕" value={model.translatedCount} tone="#f59e0b" />
                    <MetricCard label="可合成音频" value={model.dubbedReadyCount} tone="#34d399" />
                    <MetricCard label="失败音频" value={model.dubbedErrorCount} tone="#f87171" />
                </div>
            </div>

            {model.insights.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: compact ? '10px' : '16px' }}>
                    {model.insights.map((item) => (
                        <InsightBadge key={`${item.label}-${item.value}`} label={item.label} value={item.value} tone={item.tone} />
                    ))}
                </div>
            )}

            {!compact && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(150px, 1fr))', gap: '12px', marginTop: '16px' }}>
                    {model.steps.map((step) => {
                        const tone = palette[step.status];
                        return (
                            <div key={step.key} style={{
                                padding: '12px',
                                borderRadius: '12px',
                                background: 'rgba(255,255,255,0.04)',
                                border: '1px solid rgba(255,255,255,0.08)'
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                    <div style={{ color: '#fff', fontWeight: 600, fontSize: '0.92em' }}>{step.label}</div>
                                    <span style={{
                                        padding: '2px 8px',
                                        borderRadius: '999px',
                                        background: tone.bg,
                                        color: tone.color,
                                        fontSize: '0.72em',
                                        fontWeight: 700
                                    }}>
                                        {statusLabel(step.status)}
                                    </span>
                                </div>
                                <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: '0.82em', lineHeight: 1.55, marginTop: '8px' }}>
                                    {step.detail}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function MetricCard({ label, value, tone }: { label: string; value: number; tone: string }) {
    return (
        <div style={{
            padding: '10px 12px',
            borderRadius: '12px',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)'
        }}>
            <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.78em' }}>{label}</div>
            <div style={{ color: tone, fontSize: '1.12em', fontWeight: 700, marginTop: '4px' }}>{value}</div>
        </div>
    );
}

function InsightBadge({
    label,
    value,
    tone = 'neutral'
}: {
    label: string;
    value: string;
    tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
}) {
    const palette = {
        neutral: { color: '#e5e7eb', bg: 'rgba(255,255,255,0.06)', border: 'rgba(255,255,255,0.08)' },
        info: { color: '#bfdbfe', bg: 'rgba(59,130,246,0.14)', border: 'rgba(96,165,250,0.18)' },
        success: { color: '#bbf7d0', bg: 'rgba(34,197,94,0.14)', border: 'rgba(74,222,128,0.18)' },
        warning: { color: '#fde68a', bg: 'rgba(245,158,11,0.14)', border: 'rgba(251,191,36,0.18)' },
        danger: { color: '#fecaca', bg: 'rgba(248,113,113,0.14)', border: 'rgba(248,113,113,0.2)' }
    } as const;
    const colors = palette[tone];

    return (
        <div style={{
            padding: '8px 10px',
            borderRadius: '10px',
            background: colors.bg,
            border: `1px solid ${colors.border}`,
            minWidth: '120px'
        }}>
            <div style={{ color: 'rgba(255,255,255,0.56)', fontSize: '0.76em' }}>{label}</div>
            <div style={{ color: colors.color, fontSize: '0.84em', fontWeight: 700, marginTop: '3px' }}>{value}</div>
        </div>
    );
}

function statusLabel(status: WorkflowStepState['status']) {
    switch (status) {
        case 'idle':
            return '待开始';
        case 'ready':
            return '就绪';
        case 'active':
            return '进行中';
        case 'done':
            return '完成';
        case 'blocked':
            return '待补齐';
        case 'error':
            return '异常';
        default:
            return status;
    }
}
