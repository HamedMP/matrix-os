export const ATS_STAGES = [
  'applied',
  'screening',
  'intro_call',
  'technical_interview',
  'founder_interview',
  'reference_check',
  'offer',
  'hired',
] as const;

export const ATS_DISPOSITIONS = [
  'active',
  'rejected',
  'withdrawn',
  'archived',
] as const;

export type AtsStage = (typeof ATS_STAGES)[number];
export type AtsDisposition = (typeof ATS_DISPOSITIONS)[number];

export interface AtsApplicationSummary {
  id: string;
  submissionKey: string;
  roleSlug: string;
  candidateName: string;
  candidateEmail: string;
  phone: string | null;
  location: string;
  availability: string;
  links: Record<string, string>;
  answers: Array<{ prompt: string; answer: string }>;
  source: string;
  stage: AtsStage;
  disposition: AtsDisposition;
  revision: number;
  ownerId: string | null;
  tags: string[];
  nextActionAt: string | null;
  dispositionReason: string | null;
  consentAt: string;
  retentionUntil: string;
  resumeFilename: string;
  resumeContentType: string;
  createdAt: string;
  updatedAt: string;
}

export interface AtsEvent {
  id: string;
  applicationId: string;
  eventType: string;
  actorId: string | null;
  fromStage: string | null;
  toStage: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface AtsNote {
  id: string;
  applicationId: string;
  authorId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface AtsScorecard {
  id: string;
  applicationId: string;
  interviewerId: string;
  interviewType: string;
  recommendation: string;
  ratings: Record<string, number>;
  strengths: string;
  concerns: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AtsInterview {
  id: string;
  applicationId: string;
  interviewType: string;
  status: string;
  interviewerIds: string[];
  bookingUrl: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  timezone: string | null;
  meetingLocation: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AtsTask {
  id: string;
  applicationId: string;
  title: string;
  assigneeId: string | null;
  dueAt: string | null;
  status: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AtsApplicationDetail extends AtsApplicationSummary {
  events: AtsEvent[];
  notes: AtsNote[];
  scorecards: AtsScorecard[];
  interviews: AtsInterview[];
  tasks: AtsTask[];
}

