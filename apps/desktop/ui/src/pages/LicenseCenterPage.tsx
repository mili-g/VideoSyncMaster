import LicenseCenterView from '../components/LicenseCenterView';
import PageFrame from '../layout/PageFrame';

export default function LicenseCenterPage() {
    return (
        <div className="view-page-shell">
            <PageFrame
                eyebrow="Licensing"
                title="授权中心"
                description=""
                headerMode="hidden"
            >
                <LicenseCenterView />
            </PageFrame>
        </div>
    );
}
