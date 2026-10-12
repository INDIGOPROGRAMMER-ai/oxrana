import { createFileRoute } from '@tanstack/react-router';
import { WizardFrame } from '../components/wizard';

export const Route = createFileRoute('/admin/setup/$step')({
  component: () => <WizardFrame slug={Route.useParams().step} />,
});
