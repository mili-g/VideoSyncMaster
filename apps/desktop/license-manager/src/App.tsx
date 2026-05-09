import { useCallback, useEffect, useMemo, useState } from 'react'
import type { IssueLicenseResponse, LicensingOverviewResponse, PlanDefinition } from './types'

type FeedbackState = { type: 'success' | 'error'; message: string } | null
const ACTIVATION_SEGMENT_LENGTH = 24
const ACTIVATION_SEGMENT_COUNT = 9

function getPlanDurationLabel(cycle: PlanDefinition['cycle']) {
  if (cycle === 'monthly') return '30 天'
  if (cycle === 'quarterly') return '90 天'
  return '365 天'
}

function formatDateLabel(value?: string) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toISOString().slice(0, 10)
}

export default function App() {
  const [maximized, setMaximized] = useState(false)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<FeedbackState>(null)
  const [overview, setOverview] = useState<LicensingOverviewResponse | null>(null)
  const [selectedPlanId, setSelectedPlanId] = useState('starter-monthly')
  const [deviceCode, setDeviceCode] = useState('')
  const [activationCode, setActivationCode] = useState('')

  useEffect(() => {
    let active = true
    void window.api.isWindowMaximized().then((value: boolean) => {
      if (active) {
        setMaximized(Boolean(value))
      }
    })
    return () => {
      active = false
    }
  }, [])

  const loadOverview = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.api.getLicensingOverview()
      setOverview(result)
      setSelectedPlanId((prev) => result.plans.find((item: PlanDefinition) => item.id === prev)?.id || result.plans[0]?.id || prev)
      if (!result.success && result.error) {
        setFeedback({ type: 'error', message: result.error })
      }
    } catch (error) {
      setFeedback({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  const plans = useMemo(() => overview?.plans || [], [overview])
  const selectedPlan = useMemo(
    () => plans.find((item) => item.id === selectedPlanId) || plans[0],
    [plans, selectedPlanId]
  )
  const latestPayload = overview?.latestIssuedLicense?.payload
  const activationSegments = useMemo(() => splitActivationCode(activationCode), [activationCode])

  const handleIssueLicense = async () => {
    if (!selectedPlan) {
      setFeedback({ type: 'error', message: '未选择有效套餐。' })
      return
    }
    if (!deviceCode.trim()) {
      setFeedback({ type: 'error', message: '请输入设备识别码。' })
      return
    }

    setSubmitting(true)
    try {
      const result = await window.api.issueLicense({
        deviceCode: deviceCode.trim(),
        planId: selectedPlan.id
      }) as IssueLicenseResponse

      if (!result.success || !result.activationCode) {
        setFeedback({ type: 'error', message: result.error || '授权码生成失败。' })
        return
      }

      setActivationCode(result.activationCode)
      setFeedback({ type: 'success', message: '授权码已生成。' })
      await loadOverview()
    } catch (error) {
      setFeedback({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setSubmitting(false)
    }
  }

  const handleCopyActivationCode = async () => {
    if (!activationCode.trim()) return
    try {
      await navigator.clipboard.writeText(activationCode)
      setFeedback({ type: 'success', message: '授权码已复制。' })
    } catch (error) {
      setFeedback({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  return (
    <div style={shellStyle}>
      <div style={titlebarStyle} aria-label="应用标题栏">
        <div style={identityStyle}>
          <strong>VideoSync License Manager</strong>
          <span style={identitySubStyle}>授权管理器</span>
        </div>
        <div style={windowControlsStyle}>
          <button type="button" style={windowButtonStyle} title="最小化" onClick={() => void window.api.minimizeWindow()}>-</button>
          <button
            type="button"
            style={windowButtonStyle}
            title={maximized ? '还原' : '最大化'}
            onClick={async () => {
              await window.api.toggleMaximizeWindow()
              setMaximized(await window.api.isWindowMaximized())
            }}
          >
            {maximized ? '[]' : '[ ]'}
          </button>
          <button type="button" style={closeButtonStyle} title="关闭" onClick={() => void window.api.closeWindow()}>x</button>
        </div>
      </div>

      <main style={mainStyle}>
        <section style={heroStyle}>
          <div>
            <div style={eyebrowStyle}>License Issuer</div>
            <h1 style={heroTitleStyle}>授权码生成</h1>
            <p style={heroDescStyle}>选择套餐并输入设备识别码，直接生成可供客户端激活的授权码。</p>
          </div>
          <div style={heroMetaStyle}>
            <div style={metricStyle}>
              <span style={metricLabelStyle}>年费上限</span>
              <strong style={metricValueStyle}>129 元</strong>
            </div>
            <div style={metricStyle}>
              <span style={metricLabelStyle}>已签发</span>
              <strong style={metricValueStyle}>{overview?.keyVault.issuedLicenseCount ?? 0}</strong>
            </div>
            <div style={metricStyle}>
              <span style={metricLabelStyle}>最近到期</span>
              <strong style={metricValueStyle}>{formatDateLabel(latestPayload?.validUntil)}</strong>
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

        <section style={contentStyle}>
          <div style={panelStyle}>
            <div style={panelHeadStyle}>
              <div>
                <h2 style={sectionTitleStyle}>套餐</h2>
                <p style={sectionDescStyle}>按套餐时长生成授权码。</p>
              </div>
            </div>
            <div style={planGridStyle}>
              {plans.map((plan) => {
                const selected = plan.id === selectedPlanId
                return (
                  <button
                    key={plan.id}
                    type="button"
                    onClick={() => setSelectedPlanId(plan.id)}
                    style={{
                      ...planCardStyle,
                      borderColor: selected ? 'rgba(96,165,250,0.56)' : 'rgba(148,163,184,0.16)'
                    }}
                  >
                    <div style={planTopStyle}>
                      <strong style={planNameStyle}>{plan.name}</strong>
                      <span style={planPriceStyle}>{plan.priceLabel}</span>
                    </div>
                    <div style={planMetaStyle}>{getPlanDurationLabel(plan.cycle)}</div>
                  </button>
                )
              })}
            </div>

            <div style={fieldGroupStyle}>
              <label style={fieldLabelStyle}>设备识别码</label>
              <textarea
                value={deviceCode}
                onChange={(event) => setDeviceCode(event.target.value)}
                placeholder="粘贴客户端展示的设备识别码"
                style={textareaStyle}
              />
            </div>

            <div style={buttonRowStyle}>
              <button type="button" className="secondary-button" onClick={() => void loadOverview()} disabled={loading || submitting}>
                刷新
              </button>
              <button type="button" className="primary-button" onClick={() => void handleIssueLicense()} disabled={submitting || loading}>
                生成授权码
              </button>
            </div>
          </div>

          <div style={panelStyle}>
            <div style={panelHeadStyle}>
              <div>
                <h2 style={sectionTitleStyle}>授权码</h2>
                <p style={sectionDescStyle}>将生成结果复制给客户端直接激活。</p>
              </div>
            </div>

            <div style={activationGridStyle}>
              {activationSegments.map((segment, index) => (
                <input
                  key={`activation-code-${index}`}
                  value={segment}
                  readOnly
                  placeholder="生成后显示"
                  style={activationInputStyle}
                />
              ))}
            </div>

            <div style={buttonRowStyle}>
              <div style={hintStyle}>签发归档：{overview?.vaultPath || '-'}</div>
              <button type="button" className="primary-button" onClick={() => void handleCopyActivationCode()} disabled={!activationCode}>
                复制授权码
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}

const shellStyle: React.CSSProperties = {
  height: '100vh',
  overflow: 'hidden',
  background: '#08111f',
  color: '#e2e8f0'
}

const titlebarStyle: React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' } = {
  height: 52,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0 16px',
  borderBottom: '1px solid rgba(148,163,184,0.12)',
  WebkitAppRegion: 'drag'
}

const identityStyle: React.CSSProperties = {
  display: 'grid',
  gap: 2
}

const identitySubStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#94a3b8'
}

const windowControlsStyle: React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' } = {
  display: 'flex',
  gap: 8,
  WebkitAppRegion: 'no-drag'
}

const windowButtonStyle: React.CSSProperties = {
  width: 36,
  height: 28,
  borderRadius: 8,
  border: '1px solid rgba(148,163,184,0.16)',
  background: 'rgba(15,23,42,0.72)',
  color: '#e2e8f0',
  cursor: 'pointer'
}

const closeButtonStyle: React.CSSProperties = {
  ...windowButtonStyle,
  color: '#fecaca'
}

const mainStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateRows: 'auto auto minmax(0, 1fr)',
  gap: 14,
  padding: 14,
  height: 'calc(100vh - 52px)',
  boxSizing: 'border-box',
  overflow: 'hidden'
}

const heroStyle: React.CSSProperties = {
  display: 'grid',
  gap: 12,
  padding: '18px 20px',
  borderRadius: 16,
  background: 'linear-gradient(180deg, rgba(15,23,42,0.78), rgba(15,23,42,0.58))',
  border: '1px solid rgba(96,165,250,0.18)'
}

const eyebrowStyle: React.CSSProperties = {
  fontSize: 12,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: '#93c5fd',
  marginBottom: 6
}

const heroTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 26,
  color: '#f8fafc'
}

const heroDescStyle: React.CSSProperties = {
  margin: '6px 0 0',
  color: '#94a3b8',
  lineHeight: 1.5
}

const heroMetaStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 10
}

const metricStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  padding: '12px 14px',
  borderRadius: 12,
  background: 'rgba(15,23,42,0.5)',
  border: '1px solid rgba(148,163,184,0.14)'
}

const metricLabelStyle: React.CSSProperties = {
  color: '#94a3b8',
  fontSize: 13
}

const metricValueStyle: React.CSSProperties = {
  color: '#f8fafc',
  fontSize: 20
}

const noticeStyle: React.CSSProperties = {
  padding: '12px 14px',
  borderRadius: 12,
  background: 'rgba(15,23,42,0.52)',
  border: '1px solid rgba(148,163,184,0.16)'
}

const contentStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1.15fr) minmax(340px, 0.85fr)',
  gap: 12,
  minHeight: 0
}

const panelStyle: React.CSSProperties = {
  display: 'grid',
  gap: 12,
  padding: '16px 18px',
  borderRadius: 16,
  background: 'rgba(15,23,42,0.52)',
  border: '1px solid rgba(148,163,184,0.16)',
  minHeight: 0,
  alignContent: 'start'
}

const panelHeadStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start'
}

const sectionTitleStyle: React.CSSProperties = {
  margin: 0,
  color: '#f8fafc',
  fontSize: 17
}

const sectionDescStyle: React.CSSProperties = {
  margin: '4px 0 0',
  color: '#94a3b8',
  lineHeight: 1.45
}

const planGridStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))'
}

const planCardStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  padding: '12px',
  borderRadius: 12,
  background: 'rgba(8,15,28,0.84)',
  border: '1px solid rgba(148,163,184,0.16)',
  color: '#e2e8f0',
  cursor: 'pointer',
  textAlign: 'left'
}

const planTopStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6
}

const planNameStyle: React.CSSProperties = {
  color: '#f8fafc',
  fontSize: 14
}

const planPriceStyle: React.CSSProperties = {
  color: '#fde68a',
  fontWeight: 800,
  fontSize: 17,
  whiteSpace: 'nowrap'
}

const planMetaStyle: React.CSSProperties = {
  color: '#94a3b8',
  fontSize: 13
}

const fieldGroupStyle: React.CSSProperties = {
  display: 'grid',
  gap: 8
}

const fieldLabelStyle: React.CSSProperties = {
  color: '#cbd5e1',
  fontWeight: 600,
  fontSize: 14
}

const textareaStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 78,
  resize: 'vertical',
  borderRadius: 12,
  border: '1px solid rgba(148,163,184,0.16)',
  background: 'rgba(8,15,28,0.92)',
  color: '#e2e8f0',
  padding: '10px 12px',
  lineHeight: 1.45,
  fontSize: 13,
  fontFamily: 'Consolas, ui-monospace, SFMono-Regular, Menlo, monospace'
}

const activationGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 10
}

const activationInputStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 44,
  borderRadius: 12,
  border: '1px solid rgba(148,163,184,0.16)',
  background: 'rgba(8,15,28,0.92)',
  color: '#e2e8f0',
  padding: '10px 12px',
  lineHeight: 1.2,
  fontSize: 13,
  letterSpacing: '0.02em',
  fontFamily: 'Consolas, ui-monospace, SFMono-Regular, Menlo, monospace'
}

const buttonRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  flexWrap: 'wrap'
}

const hintStyle: React.CSSProperties = {
  color: '#94a3b8',
  fontSize: 13
}

function sanitizeActivationChunk(value: string) {
  return String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '')
}

function splitActivationCode(value: string) {
  const normalized = sanitizeActivationChunk(value)
  return Array.from({ length: ACTIVATION_SEGMENT_COUNT }, (_, index) => (
    normalized.slice(index * ACTIVATION_SEGMENT_LENGTH, (index + 1) * ACTIVATION_SEGMENT_LENGTH)
  ))
}
