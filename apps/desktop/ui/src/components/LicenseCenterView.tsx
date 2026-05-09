import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivateLicenseResponse, LicensingOverviewResponse } from '../types/licensing';

type FeedbackState = { type: 'success' | 'error'; message: string } | null;
const ACTIVATION_SEGMENT_LENGTH = 24;
const ACTIVATION_SEGMENT_COUNT = 9;

function formatDateLabel(value?: string) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toISOString().slice(0, 10);
}

export default function LicenseCenterView() {
    const [overview, setOverview] = useState<LicensingOverviewResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [feedback, setFeedback] = useState<FeedbackState>(null);
    const [activationCode, setActivationCode] = useState('');
    const segmentRefs = useRef<Array<HTMLInputElement | null>>([]);

    const loadOverview = useCallback(async () => {
        setLoading(true);
        try {
            const result = await window.api.getLicensingOverview();
            setOverview(result);
            if (!result.success && result.error && result.machine?.available !== false) {
                setFeedback({ type: 'error', message: result.error });
            }
        } catch (error) {
            setFeedback({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadOverview();
    }, [loadOverview]);

    const plans = useMemo(() => overview?.plans || [], [overview]);
    const activeLicense = overview?.activeLicense;
    const machineCode = overview?.machine.fingerprint || overview?.machine.shortFingerprint || '';
    const activationSegments = useMemo(
        () => splitActivationCode(activationCode),
        [activationCode]
    );

    const handleCopyDeviceCode = async () => {
        if (!machineCode) return;
        try {
            await navigator.clipboard.writeText(machineCode);
            setFeedback({ type: 'success', message: '设备识别码已复制。' });
        } catch (error) {
            setFeedback({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        }
    };

    const handleActivate = async () => {
        const code = normalizeActivationCode(activationCode);
        if (!code) {
            setFeedback({ type: 'error', message: '请输入授权码。' });
            return;
        }

        setSubmitting(true);
        try {
            const result = await window.api.activateLicenseCode({ activationCode: code }) as ActivateLicenseResponse;
            if (!result.success) {
                setFeedback({ type: 'error', message: result.error || '授权激活失败。' });
            } else {
                setFeedback({ type: 'success', message: '授权已激活。' });
                setActivationCode('');
                await loadOverview();
            }
        } catch (error) {
            setFeedback({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        } finally {
            setSubmitting(false);
        }
    };

    const updateActivationSegment = (index: number, rawValue: string) => {
        const sanitized = sanitizeActivationChunk(rawValue).slice(0, ACTIVATION_SEGMENT_LENGTH);
        const nextSegments = splitActivationCode(activationCode);
        nextSegments[index] = sanitized;
        setActivationCode(joinActivationSegments(nextSegments));
        if (sanitized.length === ACTIVATION_SEGMENT_LENGTH && index < ACTIVATION_SEGMENT_COUNT - 1) {
            segmentRefs.current[index + 1]?.focus();
            segmentRefs.current[index + 1]?.select();
        }
    };

    const handleActivationPaste = (index: number, pastedText: string) => {
        const normalized = normalizeActivationCode(pastedText);
        if (!normalized) return;
        const incomingSegments = splitActivationCode(normalized);
        const nextSegments = splitActivationCode(activationCode);
        for (let segmentIndex = index; segmentIndex < ACTIVATION_SEGMENT_COUNT; segmentIndex += 1) {
            nextSegments[segmentIndex] = incomingSegments[segmentIndex - index] || '';
        }
        setActivationCode(joinActivationSegments(nextSegments));
    };

    return (
        <div style={pageStyle}>
            <section style={heroStyle}>
                <div style={heroCopyStyle}>
                    <div style={eyebrowStyle}>Commercial License</div>
                    <h2 style={titleStyle}>商业授权</h2>
                    <p style={subtitleStyle}>在当前终端查看识别码、订阅方案与授权有效期，并使用授权码完成激活。</p>
                </div>
                <div style={heroMetricGridStyle}>
                    <div style={metricStyle}>
                        <span style={metricLabelStyle}>当前状态</span>
                        <strong style={metricValueStyle}>{activeLicense?.validNow ? '已激活' : '未激活'}</strong>
                        <span style={metricHintStyle}>{activeLicense?.validNow ? '当前终端授权有效' : '需要输入授权码激活'}</span>
                    </div>
                    <div style={metricStyle}>
                        <span style={metricLabelStyle}>当前套餐</span>
                        <strong style={metricValueStyle}>{activeLicense?.planName || '-'}</strong>
                        <span style={metricHintStyle}>激活后显示套餐信息</span>
                    </div>
                    <div style={metricStyle}>
                        <span style={metricLabelStyle}>到期日期</span>
                        <strong style={metricValueStyle}>{formatDateLabel(activeLicense?.validUntil)}</strong>
                        <span style={metricHintStyle}>按授权周期自动核验</span>
                    </div>
                </div>
            </section>

            {feedback && (
                <div style={{
                    ...noticeStyle,
                    borderColor: feedback.type === 'success' ? 'rgba(16,185,129,0.34)' : 'rgba(248,113,113,0.34)',
                    color: feedback.type === 'success' ? '#d1fae5' : '#fee2e2'
                }}>
                    {feedback.message}
                </div>
            )}

            <section style={contentGridStyle}>
                <div style={panelStyle}>
                    <div style={panelHeadStyle}>
                        <div>
                            <h3 style={sectionTitleStyle}>订阅方案</h3>
                            <p style={sectionDescStyle}>年费最高 129 元，适配个人与轻量生产场景。</p>
                        </div>
                    </div>
                    <div style={planGridStyle}>
                        {plans.map((plan) => {
                            const isActive = activeLicense?.planId === plan.id && activeLicense?.validNow;
                            return (
                                <div
                                    key={plan.id}
                                    style={{
                                        ...planCardStyle,
                                        borderColor: isActive ? 'rgba(96,165,250,0.52)' : 'rgba(148,163,184,0.16)'
                                    }}
                                >
                                    <div style={planHeaderStyle}>
                                        <div>
                                            <div style={planNameStyle}>{plan.name}</div>
                                            <div style={planDescStyle}>{plan.description}</div>
                                        </div>
                                        <div style={planPriceStyle}>{plan.priceLabel}</div>
                                    </div>
                                    <div style={planFeaturesStyle}>
                                        {plan.features.map((feature) => (
                                            <span key={feature} style={featureTagStyle}>{feature}</span>
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>

                <div style={panelStyle}>
                    <div style={panelHeadStyle}>
                        <div>
                            <h3 style={sectionTitleStyle}>激活</h3>
                            <p style={sectionDescStyle}>将设备识别码发送给授权方，获取授权码后在此激活。</p>
                        </div>
                    </div>
                    <div style={fieldGroupStyle}>
                        <label style={fieldLabelStyle}>设备识别码</label>
                        <textarea
                            value={machineCode}
                            readOnly
                            style={readonlyTextareaStyle}
                        />
                        <div style={actionRowStyle}>
                            <button type="button" className="secondary-button" onClick={() => void handleCopyDeviceCode()} disabled={!machineCode}>
                                复制识别码
                            </button>
                            <button type="button" className="secondary-button" onClick={() => void loadOverview()} disabled={loading || submitting}>
                                刷新状态
                            </button>
                        </div>
                    </div>
                    <div style={fieldGroupStyle}>
                        <label style={fieldLabelStyle}>授权码</label>
                        <div style={activationGridStyle}>
                            {activationSegments.map((segment, index) => (
                                <input
                                    key={`activation-segment-${index}`}
                                    ref={(node) => {
                                        segmentRefs.current[index] = node;
                                    }}
                                    value={segment}
                                    onChange={(event) => updateActivationSegment(index, event.target.value)}
                                    onPaste={(event) => {
                                        event.preventDefault();
                                        handleActivationPaste(index, event.clipboardData.getData('text'));
                                    }}
                                    placeholder="粘贴自动填充"
                                    style={activationInputStyle}
                                />
                            ))}
                        </div>
                    </div>
                    <div style={footerRowStyle}>
                        <div style={contactHintStyle}>商务邮箱：1556049389@qq.com</div>
                        <button type="button" className="primary-button" onClick={() => void handleActivate()} disabled={submitting}>
                            激活授权
                        </button>
                    </div>
                </div>
            </section>
        </div>
    );
}

const pageStyle: React.CSSProperties = {
    display: 'grid',
    gap: 14
};

const heroStyle: React.CSSProperties = {
    display: 'grid',
    gap: 12,
    padding: '20px 22px',
    borderRadius: 16,
    background: 'linear-gradient(180deg, rgba(15,23,42,0.74), rgba(15,23,42,0.54))',
    border: '1px solid rgba(96,165,250,0.18)'
};

const heroCopyStyle: React.CSSProperties = {
    display: 'grid',
    gap: 6
};

const eyebrowStyle: React.CSSProperties = {
    fontSize: '0.78em',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: '#93c5fd'
};

const titleStyle: React.CSSProperties = {
    margin: 0,
    fontSize: '1.8rem',
    color: '#f8fafc'
};

const subtitleStyle: React.CSSProperties = {
    margin: 0,
    lineHeight: 1.55,
    color: '#94a3b8',
    maxWidth: 720
};

const heroMetricGridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 10
};

const metricStyle: React.CSSProperties = {
    padding: '12px 14px',
    borderRadius: 12,
    background: 'rgba(15,23,42,0.52)',
    border: '1px solid rgba(148,163,184,0.16)',
    display: 'grid',
    gap: 6
};

const metricLabelStyle: React.CSSProperties = {
    color: '#94a3b8',
    fontSize: '0.84em'
};

const metricValueStyle: React.CSSProperties = {
    color: '#f8fafc',
    fontSize: '1rem'
};

const metricHintStyle: React.CSSProperties = {
    color: '#64748b',
    fontSize: '0.76rem',
    lineHeight: 1.4
};

const noticeStyle: React.CSSProperties = {
    padding: '12px 14px',
    borderRadius: 12,
    background: 'rgba(15,23,42,0.52)',
    border: '1px solid rgba(148,163,184,0.16)'
};

const contentGridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.1fr) minmax(360px, 0.9fr)',
    gap: 14
};

const panelStyle: React.CSSProperties = {
    display: 'grid',
    gap: 14,
    padding: '18px 20px',
    borderRadius: 16,
    background: 'rgba(15,23,42,0.52)',
    border: '1px solid rgba(148,163,184,0.16)'
};

const panelHeadStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 10
};

const sectionTitleStyle: React.CSSProperties = {
    margin: 0,
    color: '#f8fafc',
    fontSize: '1rem'
};

const sectionDescStyle: React.CSSProperties = {
    margin: '4px 0 0',
    color: '#94a3b8',
    lineHeight: 1.5
};

const planGridStyle: React.CSSProperties = {
    display: 'grid',
    gap: 10
};

const planCardStyle: React.CSSProperties = {
    display: 'grid',
    gap: 10,
    padding: '14px 16px',
    borderRadius: 12,
    border: '1px solid rgba(148,163,184,0.16)',
    background: 'rgba(15,23,42,0.46)'
};

const planHeaderStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'center'
};

const planNameStyle: React.CSSProperties = {
    color: '#f8fafc',
    fontWeight: 700,
    marginBottom: 4
};

const planDescStyle: React.CSSProperties = {
    color: '#94a3b8',
    fontSize: '0.84rem',
    lineHeight: 1.45
};

const planPriceStyle: React.CSSProperties = {
    color: '#fde68a',
    fontWeight: 800,
    fontSize: '1.16rem',
    whiteSpace: 'nowrap'
};

const planFeaturesStyle: React.CSSProperties = {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap'
};

const featureTagStyle: React.CSSProperties = {
    padding: '5px 8px',
    borderRadius: 999,
    background: 'rgba(30,41,59,0.88)',
    border: '1px solid rgba(96,165,250,0.12)',
    color: '#cbd5e1',
    fontSize: '0.76rem'
};

const fieldGroupStyle: React.CSSProperties = {
    display: 'grid',
    gap: 8
};

const fieldLabelStyle: React.CSSProperties = {
    color: '#cbd5e1',
    fontSize: '0.9rem',
    fontWeight: 600
};

const textareaBaseStyle: React.CSSProperties = {
    width: '100%',
    minHeight: 88,
    resize: 'vertical',
    borderRadius: 12,
    border: '1px solid rgba(148,163,184,0.16)',
    background: 'rgba(8,15,28,0.92)',
    color: '#e2e8f0',
    padding: '10px 12px',
    lineHeight: 1.45,
    fontSize: '0.84rem',
    fontFamily: 'Consolas, ui-monospace, SFMono-Regular, Menlo, monospace'
};

const readonlyTextareaStyle: React.CSSProperties = {
    ...textareaBaseStyle,
    minHeight: 74
};

const activationGridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 10
};

const activationInputStyle: React.CSSProperties = {
    width: '100%',
    minHeight: 44,
    borderRadius: 12,
    border: '1px solid rgba(148,163,184,0.16)',
    background: 'rgba(8,15,28,0.92)',
    color: '#e2e8f0',
    padding: '10px 12px',
    lineHeight: 1.2,
    fontSize: '0.82rem',
    letterSpacing: '0.02em',
    fontFamily: 'Consolas, ui-monospace, SFMono-Regular, Menlo, monospace'
};

const actionRowStyle: React.CSSProperties = {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap'
};

const footerRowStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12
};

const contactHintStyle: React.CSSProperties = {
    color: '#94a3b8',
    fontSize: '0.88rem'
};

function sanitizeActivationChunk(value: string) {
    return String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function normalizeActivationCode(value: string) {
    return sanitizeActivationChunk(value);
}

function splitActivationCode(value: string) {
    const normalized = normalizeActivationCode(value);
    return Array.from({ length: ACTIVATION_SEGMENT_COUNT }, (_, index) => (
        normalized.slice(index * ACTIVATION_SEGMENT_LENGTH, (index + 1) * ACTIVATION_SEGMENT_LENGTH)
    ));
}

function joinActivationSegments(segments: string[]) {
    return segments.map((segment) => sanitizeActivationChunk(segment)).join('');
}
