export interface MasteryKnownIssue {
  label: string;
  count: number;
}

export interface MasteryDomain {
  domain: string;
  method: 'ACCURACY_OUTCOME' | 'CORRECTION_VOLUME';
  masteryScore: number;
  confidenceScore: number;
  totalObservations: number;
  correctionCount: number;
  lastEvaluatedAt: string | null;
  knownIssues?: MasteryKnownIssue[];
}
