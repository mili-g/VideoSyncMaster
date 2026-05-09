import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivateLicenseResponse, LicensingOverviewResponse } from '../types/licensing';

type FeedbackState = { type: 'success' | 'error'; message: string } | null;
const ACTIVATION_SEGMENT_LENGTH = 5;

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
    const activationInputRef = useRef<HTMLInputElement | null>(null);

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
    const machineCode = overview?.machine.shortFingerprint || '';
    const activationDisplayValue = useMemo(
        () => formatActivationCodeForDisplay(activationCode),
        [activationCode]
    );
    const machineCodeDisplayValue = useMemo(
        () => formatDeviceCodeForDisplay(machineCode),
        [machineCode]
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

    const updateActivationCode = (rawValue: string) => {
        setActivationCode(normalizeActivationCode(rawValue));
    };

    const handleActivationPaste = (pastedText: string) => {
        const normalized = normalizeActivationCode(pastedText);
        if (!normalized) return;
        setActivationCode(normalized);
        requestAnimationFrame(() => {
            activationInputRef.current?.focus();
        });
    };

    return (
        <div style={pageStyle}>
            <section style={heroStyle}>
                <div style={heroCopyStyle}>
                    <div style={eyebrowStyle}>Commercial License</div>
                    <h2 style={titleStyle}>商业授权</h2>
                </div>
                <div style={heroMetricGridStyle}>
                    <div style={metricStyle}>
                        <span style={metricLabelStyle}>当前状态</span>
                        <strong style={metricValueStyle}>{activeLicense?.validNow ? '已激活' : '未激活'}</strong>
                    </div>
                    <div style={metricStyle}>
                        <span style={metricLabelStyle}>当前套餐</span>
                        <strong style={metricValueStyle}>{activeLicense?.planName || '-'}</strong>
                    </div>
                    <div style={metricStyle}>
                        <span style={metricLabelStyle}>到期日期</span>
                        <strong style={metricValueStyle}>{formatDateLabel(activeLicense?.validUntil)}</strong>
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
                                        <div style={planNameStyle}>{plan.name}</div>
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
                        </div>
                    </div>
                    <div style={fieldGroupStyle}>
                        <label style={fieldLabelStyle}>设备识别码</label>
                        <div style={deviceCodeTextStyle}>{machineCodeDisplayValue || '设备识别码不可用'}</div>
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
                        <input
                            type="text"
                            ref={activationInputRef}
                            value={activationDisplayValue}
                            onChange={(event) => updateActivationCode(event.target.value)}
                            onPaste={(event) => {
                                event.preventDefault();
                                handleActivationPaste(event.clipboardData.getData('text'));
                            }}
                            placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
                            spellCheck={false}
                            autoComplete="off"
                            style={activationInputStyle}
                        />
                    </div>
                    <div style={footerRowStyle}>
                        <div style={contactInfoStyle}>
                            <span style={contactLabelStyle}>授权联系</span>
                            <strong style={contactValueStyle}>1556049389@qq.com</strong>
                        </div>
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

const deviceCodeTextStyle: React.CSSProperties = {
    color: '#f8fafc',
    lineHeight: 1.78,
    fontSize: '1rem',
    fontWeight: 600,
    letterSpacing: '0.12em',
    wordBreak: 'break-all',
    fontFamily: 'Consolas, ui-monospace, SFMono-Regular, Menlo, monospace'
};

const activationInputStyle: React.CSSProperties = {
    width: '100%',
    minHeight: 54,
    borderRadius: 14,
    border: '1px solid rgba(96,165,250,0.22)',
    background: 'linear-gradient(180deg, rgba(8,15,28,0.98), rgba(15,23,42,0.92))',
    color: '#f8fafc',
    padding: '0 16px',
    lineHeight: 1.2,
    fontSize: '0.96rem',
    letterSpacing: '0.12em',
    boxSizing: 'border-box',
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
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    gap: 12
};

const contactInfoStyle: React.CSSProperties = {
    display: 'grid',
    gap: 3,
    minWidth: 260
};

const contactLabelStyle: React.CSSProperties = {
    color: '#cbd5e1',
    fontSize: '0.82rem',
    fontWeight: 700
};

const contactValueStyle: React.CSSProperties = {
    color: '#f8fafc',
    fontSize: '1.18rem',
    fontWeight: 800,
    letterSpacing: '0.02em'
};

function sanitizeActivationChunk(value: string) {
    return String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function normalizeActivationCode(value: string) {
    return sanitizeActivationChunk(value);
}

function formatActivationCodeForDisplay(value: string) {
    const segments = splitSegmentedCode(value, ACTIVATION_SEGMENT_LENGTH);
    if (segments.length === 0) {
        return '';
    }
    return segments.join('-');
}

function formatDeviceCodeForDisplay(value: string) {
    return sanitizeActivationChunk(value);
}

function splitSegmentedCode(value: string, segmentLength: number) {
    const normalized = sanitizeActivationChunk(value);
    if (!normalized) {
        return [];
    }

    const segments: string[] = [];
    for (let index = 0; index < normalized.length; index += segmentLength) {
        segments.push(normalized.slice(index, index + segmentLength));
    }
    return segments;
}
