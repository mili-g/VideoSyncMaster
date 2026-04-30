import React from 'react';

interface PageFrameProps {
    eyebrow?: string;
    title: string;
    description: string;
    aside?: React.ReactNode;
    children: React.ReactNode;
    actions?: React.ReactNode;
    headerMode?: 'default' | 'compact' | 'hidden';
}

export default function PageFrame({ eyebrow, title, description, aside, actions, children, headerMode = 'default' }: PageFrameProps) {
    return (
        <div className="page-frame">
            {headerMode !== 'hidden' && (
                <header className={`page-frame__hero${headerMode === 'compact' ? ' page-frame__hero--compact' : ''}`}>
                    <div>
                        {eyebrow && <span className="config-page__eyebrow">{eyebrow}</span>}
                        <h1>{title}</h1>
                        <p>{description}</p>
                    </div>
                    {(aside || actions) && (
                        <div className="page-frame__hero-side">
                            {aside}
                            {actions}
                        </div>
                    )}
                </header>
            )}
            <div className="page-frame__body">
                {children}
            </div>
        </div>
    );
}
