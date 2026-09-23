export interface GuidePage {
  href: string;
  label: string;
}

export interface GuideFeature {
  why: string;
  what: string;
  technical?: string;
  pages?: GuidePage[];
}

export type GuideStatus = 'done' | 'partial' | 'planned';

export interface GuideSection {
  id: string;
  title: string;
  icon?: string;
  status?: GuideStatus;
  intro?: string;
  features?: GuideFeature[];
}

export interface GuideGroup {
  label: string;
  sections: GuideSection[];
}

declare global {
  interface Window {
    PROJECT_GUIDE_CONTENT?: GuideGroup[];
  }
}
