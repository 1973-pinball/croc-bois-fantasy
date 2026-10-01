export interface RuleIssue {
  code: string;
  message: string;
  playerId?: string;
  pickId?: string;
  transferIndex?: number;
}

export interface ValidationResult {
  valid: boolean;
  issues: RuleIssue[];
}

export class DomainValidationError extends Error {
  constructor(public readonly issues: RuleIssue[]) {
    super(issues.map((issue) => issue.message).join(" "));
    this.name = "DomainValidationError";
  }
}

export interface DraftPick {
  readonly id: string;
  readonly season: number;
  readonly round: number;
  readonly originalFranchiseId: string;
  ownerFranchiseId: string;
  reservedForPlayerId?: string | null;
  consumedByPlayerId?: string | null;
}
