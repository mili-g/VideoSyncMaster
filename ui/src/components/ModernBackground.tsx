
import React from 'react';

interface ModernBackgroundProps {
    mode: 'gradient' | 'dark';
}

const ModernBackground: React.FC<ModernBackgroundProps> = ({ mode }) => {
    const isDark = mode === 'dark';

    return (
        <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            zIndex: -1,
            overflow: 'hidden',
            background: isDark ? '#020205' : '#f8fafc',
            pointerEvents: 'none'
        }}>
            {/* Animated Blobs */}
            <div style={{
                position: 'absolute',
                top: '-10%',
                left: '-10%',
                width: '60%',
                height: '60%',
                background: 'radial-gradient(circle, rgba(99, 102, 241, 0.15) 0%, transparent 70%)',
                filter: 'blur(80px)',
                animation: 'blob-float 20s infinite alternate ease-in-out',
                borderRadius: '50%'
            }} />

            <div style={{
                position: 'absolute',
                bottom: '-20%',
                right: '-10%',
                width: '70%',
                height: '70%',
                background: 'radial-gradient(circle, rgba(139, 92, 246, 0.1) 0%, transparent 70%)',
                filter: 'blur(100px)',
                animation: 'blob-float 25s infinite alternate-reverse ease-in-out',
                borderRadius: '50%'
            }} />

            <div style={{
                position: 'absolute',
                top: '20%',
                right: '10%',
                width: '40%',
                height: '40%',
                background: isDark
                    ? 'radial-gradient(circle, rgba(59, 130, 246, 0.1) 0%, transparent 70%)'
                    : 'radial-gradient(circle, rgba(59, 130, 246, 0.05) 0%, transparent 70%)',
                filter: 'blur(60px)',
                animation: 'blob-float 18s infinite alternate ease-in-out',
                borderRadius: '50%'
            }} />

            {/* Grain Overlay for Texture */}
            <div style={{
                position: 'absolute',
                top: 0, left: 0, width: '100%', height: '100%',
                opacity: 0.03,
                pointerEvents: 'none',
                backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3e%3cfilter id='noiseFilter'%3e%3cturbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3e%3c/filter%3e%3crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3e%3c/svg%3e")`,
            }} />

            <style>{`
                @keyframes blob-float {
                    0% { transform: translate(0, 0) scale(1); }
                    33% { transform: translate(10%, -5%) scale(1.1); }
                    66% { transform: translate(-5%, 10%) scale(0.9); }
                    100% { transform: translate(0, 0) scale(1); }
                }
            `}</style>
        </div>
    );
};

export default ModernBackground;
