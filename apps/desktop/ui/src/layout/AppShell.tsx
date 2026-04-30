import React from 'react';

interface AppShellProps {
    sidebar: React.ReactNode;
    topbar?: React.ReactNode;
    content: React.ReactNode;
    drawer?: React.ReactNode;
    overlay?: React.ReactNode;
    pageTitle?: string;
}

export default function AppShell({ sidebar, topbar, content, drawer, overlay, pageTitle }: AppShellProps) {
    const [maximized, setMaximized] = React.useState(false);

    React.useEffect(() => {
        let active = true;
        void window.api.isWindowMaximized().then((value) => {
            if (active) {
                setMaximized(Boolean(value));
            }
        });
        return () => {
            active = false;
        };
    }, []);

    return (
        <div className="app-shell">
            <div className="app-titlebar" aria-label="应用标题栏">
                <div className="app-titlebar__identity">
                    <span className="app-titlebar__page">
                        <strong>{pageTitle ? `VideoSyncMaster · ${pageTitle}` : 'VideoSyncMaster'}</strong>
                    </span>
                </div>
            </div>
            <div className="app-window-controls">
                <button type="button" className="app-window-control-button" title="最小化" onClick={() => void window.api.minimizeWindow()}>
                    <span className="app-window-control-button__glyph app-window-control-button__glyph--minimize" />
                </button>
                <button
                    type="button"
                    className="app-window-control-button"
                    title={maximized ? '还原' : '最大化'}
                    onClick={async () => {
                        await window.api.toggleMaximizeWindow();
                        setMaximized(await window.api.isWindowMaximized());
                    }}
                >
                    <span className={`app-window-control-button__glyph ${maximized ? 'app-window-control-button__glyph--restore' : 'app-window-control-button__glyph--maximize'}`} />
                </button>
                <button type="button" className="app-window-control-button app-window-control-button--close" title="关闭" onClick={() => void window.api.closeWindow()}>
                    <span className="app-window-control-button__glyph app-window-control-button__glyph--close" />
                </button>
            </div>
            {sidebar}
            <div className="content-shell">
                {topbar}
                <div className="content-stage">{content}</div>
                {drawer}
            </div>
            {overlay}
        </div>
    );
}
