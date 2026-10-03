# Croc Bois UI and UX review

Reviewed October 3, 2026.

Croc Bois has a coherent visual identity and useful league-specific workflows. Keep the mascot, forest green, warm cream, orange actions, and basketball typography. The largest improvements are readable supporting text, dependable navigation, protection of unfinished work, and a draft room organized around the immediate task.

This is a review of the current working tree, including existing uncommitted features. No application code or league records were changed for this review.

## Scope and evidence

Public flows were inspected in the running local app: overview, signed-out My Team, Teams & players, keeper preview, draft room, trade archive, League Lab, charter, and keeper audit. Checks included roster/trade searches with zero results, a local keeper selection and validation, keyboard navigation, DOM semantics, computed typography, and page depth. Desktop was reviewed at 1440 × 1000; phone views at 390 × 844; narrow audit reflow at 320 × 800; draft reflow was spot-checked at 768 × 1024.

Authenticated commissioner and owner workflows were reviewed in source. Their findings below are marked **Code** and need real-account verification before implementation is considered complete. Official saves, trades, draws, publishing, and locks were not exercised. Lottery replay was inspected in source; no valid shared replay was used. This is a heuristic and implementation review, not a complete assistive-technology or cross-browser conformance test.

**Observed** means reproduced in the browser. **Code** means established from implementation, with the user-facing outcome inferred where no authenticated runtime was available. **Proposal** means a design improvement rather than a demonstrated defect. Source lines may move as the ongoing project changes.

## Highest priority findings

### 1 Closed mobile navigation accepts invisible keyboard focus

**High · Observed and Code · Small to medium change**

At 390px, pressing Tab from the skip link focused the offscreen brand button. Its rectangle ran from x = −225 to −17. Opening the drawer and pressing Escape left `aria-expanded="true"`. The closed sidebar is translated offscreen but remains interactive.

Hide or make the closed drawer inert. On opening, move focus into it; on closing, return focus to the menu button. Support Escape and define consistent modal behavior, including background interaction and scroll.

**Acceptance:** A keyboard user never enters invisible navigation, can dismiss the drawer with Escape, and returns to the initiating control.

Evidence: [src/components/league-portal.tsx:207](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/league-portal.tsx:207), [src/app/globals.css:10](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/app/globals.css:10).

### 2 Main navigation does not preserve location

**High · Observed and Code · Medium change**

Moving among Teams, Keepers, Draft, Trades, and Lab leaves the URL at `/` and the document title unchanged. After using the keeper validation control, opening Draft retained a 392px scroll offset, hiding the new screen heading. Source only restores `?view=my-team`; other views, team selection, and filters are not represented in navigation history.

Use real routes or URL search parameters for section and relevant context. Use links for navigation. Define heading focus and scroll behavior, restore state on Back, and give views descriptive titles. Charter anchors should also survive a reload into the charter.

**Acceptance:** A copied Draft or team URL opens the same screen; refresh preserves context; Back returns to the previous view; a fresh destination begins at a useful position.

Evidence: [src/components/league-portal.tsx:143](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/league-portal.tsx:143), [src/components/league-portal.tsx:187](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/league-portal.tsx:187), [src/app/layout.tsx:4](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/app/layout.tsx:4). The installed Next.js navigation and accessibility guides were reviewed for this recommendation.

### 3 Functional text is too small and several shared colors lack contrast

**High · Observed and Code · Medium change**

Mobile League Lab computed sizes included 7px section labels, 8px explanatory paragraphs, and 9px filters. CSS also defines 6px chart legends. Podium manager names and units are 8px. These details carry meaning, so enlarging only the page headings does not solve readability.

Calculated from declared opaque colors, `#747a70` is approximately 3.93:1 on `#f4f2e9` and 4.37:1 on `#fffefa`; table headings `#7b8476` on `#f8f8f1` are approximately 3.64:1. These fall below the 4.5:1 normal-text criterion. Final implementation should verify actual rendered backgrounds. [W3C contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)

Proposed scale: 14–16px general body text, 12–14px functional supporting text, and a restrained smaller label style only for nonessential decoration. Preserve density by reducing repeated copy and padding, collapsing secondary details, and allowing chart scrolling. Darken muted text tokens.

**Acceptance:** Filters, eligibility, costs, chart legends, podium identities, and status copy remain readable on a phone without zoom; normal text meets 4.5:1. These proposed font sizes are design recommendations, not a claimed WCAG minimum font size.

Evidence: [src/app/globals.css:1](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/app/globals.css:1), [src/app/globals.css:20](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/app/globals.css:20), [src/components/league-highlights.module.css:19](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/league-highlights.module.css:19).

### 4 Unfinished trade and review work can disappear during navigation

**High · Code · Medium change**

Trade terms, transfers, and obligations live in TradeComposer component state. Navigating elsewhere unmounts Trades. A manager checking a roster while composing a multi-team deal loses that work. In keeper profile review, choosing another player remounts the keyed form, discarding unsaved cost, tenure, and reason edits.

Preserve trade drafts by account and season, and review drafts by player, or present a clear discard decision before leaving edited work. Use the same draft/saved/submitted vocabulary throughout.

**Acceptance:** Enter a multi-leg trade, inspect a team, and return with the draft intact. Switch away from edited profile fields without silent data loss.

Evidence: [src/components/trade-workspace.tsx:40](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/trade-workspace.tsx:40), [src/components/league-portal.tsx:264](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/league-portal.tsx:264), [src/components/keeper-profile-review.tsx:182](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/keeper-profile-review.tsx:182), [src/components/keeper-profile-review.tsx:237](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/keeper-profile-review.tsx:237).

### 5 Review filters can leave a different player editable

**High · Code · Small change**

Keeper review filters the candidate list by team and search, but resolves the selected player against the entire player collection first. Changing teams or producing zero results can therefore leave an excluded player in the editable detail panel.

Clear or replace the selection when filters exclude it. If a just-reviewed player intentionally stays visible, label that as a pinned result outside the current filter and limit the exception to that workflow.

**Acceptance:** Every editable profile visibly belongs to the current results, or is explicitly identified as an exception.

Evidence: [src/components/keeper-profile-review.tsx:109](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/keeper-profile-review.tsx:109), [src/components/keeper-profile-review.tsx:115](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/keeper-profile-review.tsx:115).

## Workflow and structure improvements

### 6 Give the draft room distinct working modes

**Medium · Observed and Proposal · Medium change**

The screen stacks Live draft board, Draft rosters, Draft Pick Grids, historical ownership, and another original-slot board. At 390px after data loaded, Player pool began around y = 1469, Draft rosters at 2603, Pick Grids at 4134, and the original-slot board at 5892. The lower current-year ownership board can resemble the live board while representing different information.

Use clearly labelled modes: **Live draft**, **Pick ownership**, and **Archive**, with Draft rosters available within the live workspace. Keep the current/next pick and player search prominent. On phones, expose Board / Players / Rosters switches or jump controls. Preserve a full board for the league's in-person draft.

Before order publication, use a compact explanation and an optional board preview rather than making 104 empty cells the main experience. Keep truthful zero counts and the unpublished-order explanation.

**Acceptance:** Users can reach player search and understand the active pick without traversing unrelated historical views.

Evidence: [src/components/league-portal.tsx:254](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/league-portal.tsx:254), [src/components/live-draft-board.tsx:238](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/live-draft-board.tsx:238). Sleeper documents how a board supplies upcoming-turn and opponent-pick context; the proposed Croc Bois structure is an adaptation of that pattern. [Sleeper draftboard](https://support.sleeper.com/en/articles/1876028-why-you-should-use-sleeper-for-any-draft)

### 7 Make draft order rearrangement direct

**Medium · Code · Small to medium change**

Assigned franchises are disabled in every other slot menu. To swap two populated slots, the commissioner must first clear one, then make multiple selections. No guidance explains this.

Support an explicit swap or accessible Move up / Move down controls. Keep a clear unpublished state and the separate Publish action.

**Acceptance:** Two occupied positions can be exchanged without a hidden temporary-clear procedure.

Evidence: [src/components/live-draft-board.tsx:88](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/live-draft-board.tsx:88).

### 8 Explain validation beside draft controls

**Medium · Code · Small change**

Order notes and correction reasons require at least five trimmed characters. The field labels omit that requirement, while Publish/Save/Remove stay disabled. Draft cell Edit controls are also only 9px text with 3px padding; on mobile the editor is below the board, with no focus or scroll handoff.

Show “Required · at least 5 characters” and field-specific feedback. Enlarge edit targets and bring the selected pick's editor into view with clear context.

**Acceptance:** A commissioner can tell why an action is unavailable and where to correct the problem, without guessing or scrolling for the changed form.

Evidence: [src/components/live-draft-board.tsx:72](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/live-draft-board.tsx:72), [src/components/live-draft-board.tsx:89](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/live-draft-board.tsx:89), [src/components/live-draft-board.tsx:280](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/live-draft-board.tsx:280), [src/components/live-draft-board.module.css:50](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/live-draft-board.module.css:50).

### 9 Separate lottery priority from published draft slots

**Medium · Code · Small to medium change**

“Run Lottery for Draft Order” names a different outcome from the intro's slot-choice priority. The next step, “Manage draft order,” is plain text referring to another screen.

Use **Draft-slot choice lottery**, then show the sequence **Draw choice priority → Record chosen slots → Publish draft order**. Link directly to the order editor and retain a visible distinction between the draw and the agreed slots.

**Acceptance:** A commissioner and a replay viewer can explain which order was drawn and which order actually controls the draft board.

Evidence: [src/components/draft-lottery.tsx:111](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/draft-lottery.tsx:111), [src/components/live-draft-board.tsx:80](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/live-draft-board.tsx:80). The standalone replay already uses the more precise wording.

### 10 State the consequence of the final keeper lock at the action

**Medium · Code · Small change**

Every approved submission uses “Lock keepers,” including the final lock that reveals all teams publicly. The general explanatory copy carries the consequence, but the final action label does not.

When the final team is ready, label the action **Lock final team and reveal keepers** and show a nearby league-wide summary. Preserve the ordinary label for earlier locks.

**Acceptance:** The commissioner knows whether the click locks one private submission or triggers the public reveal.

Evidence: [src/components/league-account.tsx:301](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/league-account.tsx:301).

### 11 Align connection status with available actions

**Medium · Code · Small change**

The global account flow can retain previously loaded data while declaring an error and pausing official actions. Live draft `canDraft` does not require `account.connection === 'live'`, so its action state can contradict that message if the draft endpoint still succeeds.

Either gate actions consistently or give precise, scoped service status. Standardize Refresh wording, pending feedback, last checked time, and nearby retry actions across draft, picks, trades, and keeper review.

**Acceptance:** Simulating a league-read failure with a responsive draft endpoint produces coherent, accurate status and action availability. This scenario needs commissioner runtime testing; it was not reproduced.

Evidence: [src/components/live-draft-board.tsx:159](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/live-draft-board.tsx:159), [src/components/live-draft-board.tsx:205](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/live-draft-board.tsx:205), [src/components/league-account.tsx:65](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/league-account.tsx:65).

### 12 Complete accessible selection and table semantics

**Medium · Observed and Code · Small to medium change**

Team selectors repeat abbreviations visually and in accessible names, such as “MART MART,” and selected state is only a CSS class. The live draft's `role="table"` contains headers and cells without row wrappers, unlike the semantic ownership tables.

Use meaningful team names, a single visible abbreviation badge, and `aria-pressed` for a simple selection group. Give the live board a semantic table or complete ARIA row structure. Preserve its horizontal scroll and sticky context.

**Acceptance:** A screen reader identifies the selected team and each draft cell's round and slot. Verify with an actual screen reader after implementation.

Evidence: [src/components/league-portal.tsx:239](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/league-portal.tsx:239), [src/components/live-draft-board.tsx:238](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/live-draft-board.tsx:238).

## Visual and content polish

### 13 Use a stable loading state for overview statistics

**Medium · Observed and Code · Small to medium change**

On initial load, the overview showed 0 of 9 verified championships and fallback wins of 647 for Arod; it then changed to 9 of 9 and 847 after history loaded. A loading notice exists, but plausible statistics still compete with it and change the layout.

Reserve the final card dimensions and show skeletons or explicit loading values until the relevant history is ready. On refresh, retain verified values with a refreshing indicator rather than reverting to fallback rankings. Keep historical fallback useful when genuinely offline, but label its period prominently.

Evidence: [src/components/league-portal.tsx:231](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/league-portal.tsx:231), [src/components/league-highlights.tsx:132](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/league-highlights.tsx:132).

### 14 Standardize identity and season labels

**Polish · Observed and Proposal · Small to medium change**

The same franchise appears with Jonathan / Jon, Anthony / Arod, and Alex / Cars across profiles, pick inventory, and highlights. Some historical labels are intentional and should remain historically accurate. Team tabs also repeat the same short code in badge and text.

Use one current display name per manager and franchise in current workflows. Explicitly qualify historical manager labels. Show a friendly season label consistently, such as “2026–27 season” and “2026 draft,” while leaving stored identifiers unchanged.

Evidence: overview/profile/pick-inventory browser observations; [src/components/league-portal.tsx:239](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/league-portal.tsx:239), [src/components/league-highlights.tsx:116](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/league-highlights.tsx:116).

### 15 Make data freshness labels describe their date

**Polish · Observed and Code · Small change**

The footer reads “Live league records · 2026-03-29,” while the draft ranking source says updated 2026-10-03. These dates describe different datasets, but the generic footer can imply the live app itself is seven months out of date.

Label the frozen roster or migration snapshot date explicitly. Give refresh times only to the live dataset they describe. Avoid inventing a “last updated” value where none exists.

Evidence: [src/components/league-portal.tsx:287](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/league-portal.tsx:287), [src/components/live-draft-board.tsx:267](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/live-draft-board.tsx:267).

### 16 Reduce repeated chrome and unify the page shell

**Polish · Observed and Proposal · Medium change**

The connection line and unscheduled deadline block recur above every destination, taking useful space on phones. Overview repeats the keeper-planning invitation in the hero and next-move panel. Audit leaves the main navigation entirely and switches to much larger body copy; the title and breadcrumb system is also inconsistent across destinations.

Use one compact season-status strip, expanding details when useful. Make the overview's primary action reflect role and season phase; consolidate repeated planning prompts. Give Audit the shared shell or an intentionally consistent report shell with clear return context. Keep its more readable text as a positive example.

Evidence: [src/components/league-portal.tsx:218](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/league-portal.tsx:218), [src/components/league-portal.tsx:233](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/league-portal.tsx:233), [src/app/audit/page.tsx:9](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/app/audit/page.tsx:9).

### 17 Standardize small but frequent interactions

**Polish · Observed and Proposal · Small changes**

Roster and trade searches explain zero results, but offer no dedicated Clear search/reset action. Trade search keeps the total “93 historical trade records” without a matching count. Team, roster, pool, and Lab toolbars use different patterns.

Adopt a shared toolbar with search, filters, results count, and reset where appropriate. Keep expandable details for secondary explanations. Use “Refresh” consistently, sentence case for ordinary controls, and one hierarchy of primary/secondary/text actions. Replace the locked commissioner tooltip's “get out of here james” with useful access guidance; league humor fits better in awards and editorial copy.

Evidence: [src/components/league-portal.tsx:110](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/league-portal.tsx:110), [src/components/league-portal.tsx:211](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/league-portal.tsx:211), [src/components/league-portal.tsx:267](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/league-portal.tsx:267). Carbon's table and empty-state patterns support consistent controls and useful recovery actions. [Data tables](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines), [Empty states](https://www.carbondesignsystem.com/building-blocks/core/patterns/empty-states)

## Additional backlog items

- **Trade correction and withdrawal:** The workspace exposes logging and finalization but no obvious withdrawal/edit path, and cancelled records are excluded from the displayed lists. Define the league policy and show a reasoned withdrawal trail. This is a workflow enhancement requiring product/rule decisions. Evidence: [src/components/trade-workspace.tsx:208](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/trade-workspace.tsx:208).
- **Replay error recovery:** The replay error state says to try later but provides no retry or league-home action. Add a retry for transient failures and a useful destination for invalid or removed links. Preserve automatic animation, Skip, and Replay controls. Evidence: [src/components/lottery-replay.tsx:40](C:/Users/ARRod/OneDrive/Documents/ChatGPT/croc_bois_fantasy/src/components/lottery-replay.tsx:40).
- **Draft shortlist and presentation mode:** Worth considering after the core fixes, especially for in-person drafts. They are enhancements, not requirements for correcting the present inconsistencies.

## What to preserve

- The Croc Bois brand, mascot, warm palette, and distinct heading face.
- Compact roster rows, native Details disclosures, and the recent 44px roster/keeper selection targets.
- Clear distinction between original pick identity and current ownership.
- Local keeper validation that explicitly says nothing was officially submitted.
- Signed-out My Team's concise explanation of sign-in, team request, and commissioner approval.
- Historical evidence and coverage notes, including caveats around reconstructed data and correlation.
- Existing status/error announcements, stale-revision protection, native account dialogs, and reduced-motion treatment.

## Recommended implementation order

| Pass | Work | Completion check |
| --- | --- | --- |
| 1 | Mobile focus, navigation state, typography and contrast | Keyboard walkthrough, refresh/Back/share, phone reading and contrast verification |
| 2 | Preserve unfinished work; fix review selection; clarify validation, final lock, and connection states | Real-account owner and commissioner walkthroughs with unsaved edits and failed reads |
| 3 | Separate draft working modes; simplify slot rearrangement and lottery handoff | Full mock draft at desktop and phone sizes, including corrections |
| 4 | Loading, identities, freshness labels, toolbars, page shell | Cross-page consistency review and regression checks |

Use focused interaction tests for state retention and permission/connection behavior. Use visual and keyboard checks for layout, sizing, and focus. Test at 320, 390, 768, and 1440px, plus 200% zoom. Include a full screen-reader pass, slow/error states, and reduced motion before calling the polish complete.

The external references informed interaction patterns; they do not establish defects in Croc Bois or justify copying another product's visual identity. No additional skill installation was needed.


## Implementation record — October 3, 2026

The review’s proposed fixes are implemented. Navigation now uses bookmarkable URLs, request-aware initial rendering, focus-managed mobile navigation, and Back/Forward context. Rosters, trade history, and Lab expose result counts and reset controls. Supporting text has a 12px baseline, major body/player text is 14px, and the shared muted color is darker. Audit shares the league shell; schedule details expand from a compact status strip. Current manager labels and frozen-roster/refresh dates are distinguished. Overview statistics use a stable initial loading state.

The draft room separates live work, ownership and archive. Board / Players / Rosters switches apply at every viewport. Cards use approximately 148 × 112px minimum dimensions and include compact pick numbering, readable player names, NBA position/team, status and ownership context, informed by the [official Sleeper draftboard reference](https://sleeper.com/draftboard). The grid keeps those dimensions through horizontal scrolling. Draft order supports swaps, validation explains the minimum note length, corrections focus their editor, connection state gates official actions, and lottery choice priority has a separate publishing handoff. Shortlists, fullscreen presentation and replay recovery are included.

Trade and profile edits persist per account and season in session storage with an in-memory fallback, explicit discard, and account cleanup; profile edits also persist per player. Review filters select from visible results with an explicit exception for the player just reviewed. The final lock label and review summary state when all selections will be revealed, using the configured participant count. Migration 00014 permits reasoned commissioner withdrawal of pending live proposals and separately linked corrections with a fresh review period; it does not introduce a voting policy.

Validation: 223 domain/database tests passed, including persistence boundaries, withdrawal authorization/audit/history and unchanged review windows. TypeScript passed. Browser checks cover desktop and phone layouts, shared roster filters/reload, drawer keyboard trapping and Escape, historical cards, fullscreen presentation, audit reflow and Lab filters. Authenticated mutation behavior is covered by isolated database tests; real production submissions, locks, drafts and trades were not changed for UI testing. Screen-reader speech and real-account walkthroughs remain manual release checks; browser accessibility-tree inspection is not a substitute for those.
