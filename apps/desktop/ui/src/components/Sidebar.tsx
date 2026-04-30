import React from 'react';
import { VIEW_REGISTRY, type ViewId } from '../layout/viewRegistry';

interface SidebarProps {
    activeService: string;
    onServiceChange: (service: string) => void;
    onOpenModels?: () => void;
    hasMissingDeps?: boolean;
    themeMode?: 'light' | 'dark' | 'gradient';
}

type NavItem = {
    id: ViewId | 'repair';
    name: string;
    caption: string;
    icon: React.ReactNode;
    tone?: 'default' | 'warning';
};

const makeIcon = (paths: React.ReactNode) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" style={{ width: 24, height: 24 }}>
        {paths}
    </svg>
);

const navIconMap: Record<ViewId, React.ReactNode> = {
    home: makeIcon(
        <>
            <rect x="3.5" y="4.5" width="17" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M7.5 9h9M7.5 13h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M8 3.5v3M16 3.5v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </>
    ),
    batch: makeIcon(
        <>
            <path d="M4 8.5h7l1.8 2H20v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M4 8V6.5a2 2 0 0 1 2-2h4.5l1.7 2H18a2 2 0 0 1 2 2V10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </>
    ),
    asr: makeIcon(
        <>
            <rect x="8" y="3.5" width="8" height="12" rx="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
        </>
    ),
    tts: makeIcon(
        <>
            <path d="M4.5 13.5V10.5l5-4v11z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M13.5 9a4 4 0 0 1 0 6M16.8 6.5a7 7 0 0 1 0 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
        </>
    ),
    translation: makeIcon(
        <>
            <path d="M4.5 7h7M8 7c0 4.8-1.9 8.1-4.4 10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
            <path d="M13.5 7l6 6M19.5 7l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </>
    ),
    merge: makeIcon(
        <>
            <path d="M4 7.5h5.5l2.5 3h8v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M14.5 5.5l1 2 2 .9-2 .9-1 2-.9-2-2-.9 2-.9z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        </>
    ),
    models: makeIcon(
        <>
            <rect x="5" y="5" width="14" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M9 9h6v6H9zM9 2.5v2M15 2.5v2M9 19.5v2M15 19.5v2M19.5 9h2M19.5 15h2M2.5 9h2M2.5 15h2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
        </>
    ),
    diagnostics: makeIcon(
        <>
            <path d="M12 3.5l7 2.8v5.5c0 4.2-2.8 7.2-7 8.7-4.2-1.5-7-4.5-7-8.7V6.3z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M12 8v4.2M12 15.6h.01" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        </>
    ),
    logs: makeIcon(
        <>
            <path d="M6 4.5h9l3 3v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M15 4.5v3h3M9 11h6M9 14.5h6M9 18h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </>
    ),
    about: makeIcon(
        <>
            <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M12 10.5v5M12 7.5h.01" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        </>
    )
};

const navItems: NavItem[] = VIEW_REGISTRY
    .filter((item) => item.section === 'workflow')
    .map((item) => ({
        id: item.id,
        name: item.id === 'home'
            ? '主页'
            : item.id === 'batch'
                ? '批量'
                : item.id === 'asr'
                    ? '识别'
                    : item.id === 'tts'
                        ? '配音'
                        : item.id === 'translation'
                            ? '翻译'
                            : '合成',
        caption: item.title,
        icon: navIconMap[item.id]
    }));

const utilityItems = (hasMissingDeps?: boolean): NavItem[] => [
    {
        id: 'models',
        name: '模型',
        caption: '模型中心',
        icon: navIconMap.models
    },
    {
        id: 'diagnostics',
        name: '诊断',
        caption: hasMissingDeps ? '需要处理' : '环境诊断',
        tone: hasMissingDeps ? 'warning' : 'default',
        icon: navIconMap.diagnostics
    },
    {
        id: 'logs',
        name: '日志',
        caption: '运行日志',
        icon: navIconMap.logs
    },
    {
        id: 'about',
        name: '关于',
        caption: '版本信息',
        icon: navIconMap.about
    }
];

const Sidebar: React.FC<SidebarProps> = ({
    activeService,
    onServiceChange,
    onOpenModels,
    hasMissingDeps
}) => {
    const utilities = utilityItems(hasMissingDeps);

    const handleUtilityClick = (id: string) => {
        if (id === 'models') {
            onOpenModels?.();
            return;
        }
        if (id === 'diagnostics') {
            onServiceChange('diagnostics');
            return;
        }
        onServiceChange(id);
    };

    const renderItem = (item: NavItem, active: boolean, onClick: () => void) => (
        <button
            key={item.id}
            className={`sidebar-item${active ? ' sidebar-item--active' : ''}${item.tone === 'warning' ? ' sidebar-item--warning' : ''}`}
            onClick={onClick}
            type="button"
            title={item.caption}
        >
            <span className="sidebar-item__icon">{item.icon}</span>
            {item.tone === 'warning' ? <span className="sidebar-item__badge" aria-hidden="true" /> : null}
            <span className="sidebar-item__body">
                <span className="sidebar-item__name">{item.name}</span>
                <span className="sidebar-item__caption">{item.caption}</span>
            </span>
        </button>
    );

    return (
        <aside className="sidebar-shell">
            <div className="sidebar-brand">
                <div className="sidebar-brand__mark">
                    <img src="/icon.ico" alt="VideoSyncMaster" className="sidebar-brand__icon" />
                </div>
                <div className="sidebar-brand__text">
                    <strong>VideoSyncMaster</strong>
                    <span>工作台</span>
                </div>
            </div>

            <nav className="sidebar-section">
                <div className="sidebar-section__title">工作流</div>
                <div className="sidebar-section__items">
                    {navItems.map((item) => renderItem(item, activeService === item.id, () => onServiceChange(item.id)))}
                </div>
            </nav>

            <div className="sidebar-section sidebar-section--secondary">
                <div className="sidebar-section__title">系统</div>
                <div className="sidebar-section__items">
                    {utilities.map((item) => renderItem(item, activeService === item.id || (item.id === 'models' && activeService === 'models'), () => handleUtilityClick(item.id)))}
                </div>
            </div>
        </aside>
    );
};

export default Sidebar;
