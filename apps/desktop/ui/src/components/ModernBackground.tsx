import React from 'react';

interface ModernBackgroundProps {
    mode: 'gradient' | 'dark';
}

const ModernBackground: React.FC<ModernBackgroundProps> = ({ mode }) => {
    const isDark = mode === 'dark';

    return (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: -1,
                pointerEvents: 'none',
                overflow: 'hidden',
                background: isDark
                    ? 'linear-gradient(180deg, #07111f 0%, #0b1220 52%, #060b14 100%)'
                    : 'linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%)'
            }}
        >
            <div
                style={{
                    position: 'absolute',
                    inset: 0,
                    backgroundImage: `
                        linear-gradient(rgba(148,163,184,0.06) 1px, transparent 1px),
                        linear-gradient(90deg, rgba(148,163,184,0.06) 1px, transparent 1px)
                    `,
                    backgroundSize: '40px 40px',
                    maskImage: 'linear-gradient(180deg, rgba(0,0,0,0.42), rgba(0,0,0,0.02))'
                }}
            />

            <div
                style={{
                    position: 'absolute',
                    inset: 0,
                    background: isDark
                        ? 'radial-gradient(circle at 20% 10%, rgba(37,99,235,0.16), transparent 28%), radial-gradient(circle at 85% 22%, rgba(14,165,233,0.12), transparent 24%)'
                        : 'radial-gradient(circle at 20% 10%, rgba(37,99,235,0.08), transparent 28%), radial-gradient(circle at 85% 22%, rgba(14,165,233,0.06), transparent 24%)'
                }}
            />

            <div
                style={{
                    position: 'absolute',
                    inset: 0,
                    opacity: 0.035,
                    backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3Cturbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`
                }}
            />
        </div>
    );
};

export default ModernBackground;
