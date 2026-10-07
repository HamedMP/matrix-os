import type { Metadata } from 'next';
import { SlackInstallation } from '@/components/auth/SlackInstallation';
export const metadata: Metadata={title:'Add Matrix to Slack | Matrix OS',referrer:'no-referrer',robots:{index:false,follow:false}};
export default function SlackInstallPage(){return <SlackInstallation />;}
