export type PlayerStatus = "eligible" | "ineligible" | "review";
export interface Team { id: number; name: string; owner: string; managers: string[]; shortName: string; color: string }
export interface LeaguePlayer { id: number; name: string; teamId: number; baseCost: number | null; tenure: number | null; status: PlayerStatus; reason: string; wasKept: boolean; previousRound: number | null; rosterSlot: string }
export interface DraftPick { id: string; season: number; round: number; originalTeamId: number; ownerTeamId: number }
export interface HistoricalDraft { year: number; selections: { round: number; pick: number; originalOwner: string; owner: string; player: string; kept: boolean | null }[] }
export interface TradeRecord { id: string; parties: string[]; summary: string; notes: string; status: "recorded" | "voided" | "review" }
export interface ReviewItem { id: string; player: string; detail: string; status: "provisional" | "needs-review" }
export interface CharterSection { title: string; paragraphs: string[] }
export interface LeagueData { season: number; snapshotDate: string; teams: Team[]; players: LeaguePlayer[]; picks: DraftPick[]; drafts: HistoricalDraft[]; trades: TradeRecord[]; reviewItems: ReviewItem[]; charter: CharterSection[] }
